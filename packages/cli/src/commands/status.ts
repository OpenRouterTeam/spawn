import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import { isString, toRecord } from "@openrouter/spawn-shared";
import pc from "picocolors";
import { filterHistory, markRecordDeleted } from "../history.js";
import { loadManifest } from "../manifest.js";
import { validateServerIdentifier } from "../security.js";
import { parseJsonObj } from "../shared/parse.js";
import { asyncTryCatch, asyncTryCatchIf, isNetworkError, tryCatch, unwrapOr } from "../shared/result.js";
import { SSH_BASE_OPTS } from "../shared/ssh.js";
import { loadApiToken } from "../shared/ui.js";
import { formatRelativeTime } from "./list.js";
import { resolveDisplayName } from "./shared.js";

// ── Types ────────────────────────────────────────────────────────────────────

type LiveState = "running" | "stopped" | "gone" | "unknown";

interface ServerStatusResult {
  record: SpawnRecord;
  liveState: LiveState;
  agentAlive: boolean | null;
}

interface JsonStatusEntry {
  id: string;
  agent: string;
  cloud: string;
  ip: string;
  name: string;
  state: LiveState;
  agent_alive: boolean | null;
  spawned_at: string;
  server_id: string;
}

// ── Cloud status fetchers ────────────────────────────────────────────────────

async function fetchHetznerStatus(serverId: string, token: string): Promise<LiveState> {
  return unwrapOr(
    await asyncTryCatchIf(isNetworkError, async () => {
      const resp = await fetch(`https://api.hetzner.cloud/v1/servers/${serverId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 404) {
        return "gone" satisfies LiveState;
      }
      if (!resp.ok) {
        return "unknown" satisfies LiveState;
      }
      const text = await resp.text();
      const data = parseJsonObj(text);
      const server = toRecord(data?.server);
      const serverStatus = server?.status;
      if (!isString(serverStatus)) {
        return "unknown" satisfies LiveState;
      }
      if (serverStatus === "running") {
        return "running" satisfies LiveState;
      }
      if (serverStatus === "off") {
        return "stopped" satisfies LiveState;
      }
      return "unknown" satisfies LiveState;
    }),
    "unknown",
  );
}

async function fetchDoStatus(dropletId: string, token: string): Promise<LiveState> {
  return unwrapOr(
    await asyncTryCatchIf(isNetworkError, async () => {
      const resp = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 404) {
        return "gone" satisfies LiveState;
      }
      if (!resp.ok) {
        return "unknown" satisfies LiveState;
      }
      const text = await resp.text();
      const data = parseJsonObj(text);
      const droplet = toRecord(data?.droplet);
      const dropletStatus = droplet?.status;
      if (!isString(dropletStatus)) {
        return "unknown" satisfies LiveState;
      }
      if (dropletStatus === "active") {
        return "running" satisfies LiveState;
      }
      if (dropletStatus === "off" || dropletStatus === "archive") {
        return "stopped" satisfies LiveState;
      }
      return "unknown" satisfies LiveState;
    }),
    "unknown",
  );
}

async function checkServerStatus(record: SpawnRecord): Promise<LiveState> {
  const conn = record.connection;
  if (!conn) {
    return "unknown";
  }
  if (conn.deleted) {
    return "gone";
  }
  if (!conn.cloud || conn.cloud === "local") {
    return "running";
  }

  const serverId = conn.server_id || conn.server_name || "";
  if (!serverId) {
    return "unknown";
  }
  const validationResult = tryCatch(() => validateServerIdentifier(serverId));
  if (!validationResult.ok) {
    return "unknown";
  }

  switch (conn.cloud) {
    case "hetzner": {
      const token = loadApiToken("hetzner");
      if (!token) {
        return "unknown";
      }
      return fetchHetznerStatus(serverId, token);
    }

    case "digitalocean": {
      const token = loadApiToken("digitalocean");
      if (!token) {
        return "unknown";
      }
      return fetchDoStatus(serverId, token);
    }

    case "daytona": {
      const { getDaytonaLiveState, validateDaytonaConnection } = await import("../daytona/daytona.js");
      validateDaytonaConnection(conn);

      // Daytona status comes from the sandbox id via the SDK, not from a VM IP lookup.
      return getDaytonaLiveState(serverId);
    }

    default:
      // Other clouds (aws, gcp, sprite) require CLI or complex auth;
      // report "unknown" rather than attempting a potentially interactive flow.
      return "unknown";
  }
}

// ── Agent alive probe ───────────────────────────────────────────────────────

/**
 * Resolve the agent binary name from the manifest or the stored launch command.
 * Returns the first word of the launch string (e.g. "openclaw tui" → "openclaw").
 */
function resolveAgentBinary(record: SpawnRecord, manifest: Manifest | null): string | null {
  const fromManifest = manifest?.agents[record.agent]?.launch;
  if (fromManifest) {
    return fromManifest.split(/\s+/)[0] || null;
  }
  // Fallback: extract the last command from launch_cmd (after all source/export prefixes)
  const launchCmd = record.connection?.launch_cmd;
  if (launchCmd) {
    const parts = launchCmd.split(";").map((s) => s.trim());
    const last = parts[parts.length - 1] || "";
    return last.split(/\s+/)[0] || null;
  }
  return null;
}

/**
 * Probe a running server by SSHing in and running `{binary} --version`.
 * Returns true if the agent binary is installed and executable, false otherwise.
 */
async function probeAgentAlive(record: SpawnRecord, manifest: Manifest | null): Promise<boolean> {
  const conn = record.connection;
  if (!conn) {
    return false;
  }
  if (conn.cloud === "local") {
    return true;
  }

  const binary = resolveAgentBinary(record, manifest);
  if (!binary) {
    return false;
  }

  const versionCmd = `source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.local/bin:$HOME/.claude/local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.n/bin:$PATH"; ${binary} --version`;

  const result = await asyncTryCatch(async () => {
    let proc: {
      exited: Promise<number>;
    };

    if (conn.cloud === "sprite") {
      const name = conn.server_name || "";
      if (!name) {
        return false;
      }
      proc = Bun.spawn(
        [
          "sprite",
          "exec",
          "-s",
          name,
          "--",
          "bash",
          "-c",
          versionCmd,
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
    } else if (conn.cloud === "daytona") {
      if (!conn.server_id) {
        return false;
      }
      const { probeDaytonaAgentBinary, validateDaytonaConnection } = await import("../daytona/daytona.js");
      validateDaytonaConnection(conn);

      // Probe through the SDK so status does not depend on a separately minted SSH session.
      return probeDaytonaAgentBinary(conn.server_id, binary);
    } else {
      const user = conn.user || "root";
      const ip = conn.ip || "";
      if (!ip || ip === "sprite-console") {
        return false;
      }
      proc = Bun.spawn(
        [
          "ssh",
          ...SSH_BASE_OPTS,
          "-o",
          "ConnectTimeout=5",
          `${user}@${ip}`,
          versionCmd,
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
    }

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => {
        setTimeout(() => reject(new Error("probe timeout")), 10_000);
      }),
    ]);
    return exitCode === 0;
  });

  return result.ok ? result.data : false;
}

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtState(state: LiveState): string {
  switch (state) {
    case "running":
      return pc.green("running");
    case "stopped":
      return pc.yellow("stopped");
    case "gone":
      return pc.dim("gone");
    case "unknown":
      return pc.dim("unknown");
  }
}

function fmtProbe(alive: boolean | null): string {
  if (alive === null) {
    return pc.dim("—");
  }
  return alive ? pc.green("live") : pc.red("down");
}

function fmtIp(conn: SpawnRecord["connection"]): string {
  if (!conn) {
    return "—";
  }
  if (conn.cloud === "local") {
    return "localhost";
  }
  if (!conn.ip || conn.ip === "sprite-console") {
    return "—";
  }
  return conn.ip;
}

function col(s: string, width: number): string {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - stripped.length);
  return s + " ".repeat(padding);
}

// ── Table render ─────────────────────────────────────────────────────────────

function renderStatusTable(results: ServerStatusResult[], manifest: Manifest | null): void {
  const COL_ID = 8;
  const COL_AGENT = 12;
  const COL_CLOUD = 14;
  const COL_IP = 16;
  const COL_STATE = 12;
  const COL_PROBE = 10;
  const COL_SINCE = 12;

  const header = [
    col(pc.dim("ID"), COL_ID),
    col(pc.dim("Agent"), COL_AGENT),
    col(pc.dim("Cloud"), COL_CLOUD),
    col(pc.dim("IP"), COL_IP),
    col(pc.dim("State"), COL_STATE),
    col(pc.dim("Probe"), COL_PROBE),
    pc.dim("Since"),
  ].join(" ");

  const divider = pc.dim(
    [
      "-".repeat(COL_ID),
      "-".repeat(COL_AGENT),
      "-".repeat(COL_CLOUD),
      "-".repeat(COL_IP),
      "-".repeat(COL_STATE),
      "-".repeat(COL_PROBE),
      "-".repeat(COL_SINCE),
    ].join("-"),
  );

  console.log();
  console.log(header);
  console.log(divider);

  for (const { record, liveState, agentAlive } of results) {
    const conn = record.connection;
    const shortId = record.id ? record.id.slice(0, 6) : "??????";
    const agentDisplay = resolveDisplayName(manifest, record.agent, "agent");
    const cloudDisplay = resolveDisplayName(manifest, record.cloud, "cloud");
    const ip = fmtIp(conn);
    const state = fmtState(liveState);
    const probe = fmtProbe(agentAlive);
    const since = formatRelativeTime(record.timestamp);

    const row = [
      col(pc.dim(shortId), COL_ID),
      col(agentDisplay, COL_AGENT),
      col(cloudDisplay, COL_CLOUD),
      col(ip, COL_IP),
      col(state, COL_STATE),
      col(probe, COL_PROBE),
      pc.dim(since),
    ].join(" ");

    console.log(row);
  }

  console.log();
}

// ── JSON output ──────────────────────────────────────────────────────────────

function renderStatusJson(results: ServerStatusResult[]): void {
  const entries: JsonStatusEntry[] = results.map(({ record, liveState, agentAlive }) => ({
    id: record.id || "",
    agent: record.agent,
    cloud: record.cloud,
    ip: fmtIp(record.connection),
    name: record.name || record.connection?.server_name || "",
    state: liveState,
    agent_alive: agentAlive,
    spawned_at: record.timestamp,
    server_id: record.connection?.server_id || record.connection?.server_name || "",
  }));
  console.log(JSON.stringify(entries, null, 2));
}

// ── Main command ─────────────────────────────────────────────────────────────

export interface StatusOpts {
  prune?: boolean;
  json?: boolean;
  agentFilter?: string;
  cloudFilter?: string;
  /** Override the agent probe for testing. Called only for "running" servers. */
  probe?: (record: SpawnRecord, manifest: Manifest | null) => Promise<boolean>;
}

export async function cmdStatus(opts: StatusOpts = {}): Promise<void> {
  const records = filterHistory(opts.agentFilter, opts.cloudFilter);

  const candidates = records.filter(
    (r) => r.connection && !r.connection.deleted && r.connection.cloud && r.connection.cloud !== "local",
  );

  if (candidates.length === 0) {
    if (opts.json) {
      console.log("[]");
      return;
    }
    p.log.info("No active cloud servers found in history.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to launch your first agent.`);
    return;
  }

  const manifestResult = await asyncTryCatchIf(isNetworkError, () => loadManifest());
  const manifest: Manifest | null = manifestResult.ok ? manifestResult.data : null;

  if (!opts.json) {
    p.log.step(`Checking status of ${candidates.length} server${candidates.length !== 1 ? "s" : ""}...`);
  }

  const probeFn = opts.probe ?? probeAgentAlive;

  const results: ServerStatusResult[] = await Promise.all(
    candidates.map(async (record) => {
      const liveState = await checkServerStatus(record);
      let agentAlive: boolean | null = null;
      if (liveState === "running") {
        agentAlive = await probeFn(record, manifest);
      }
      return {
        record,
        liveState,
        agentAlive,
      };
    }),
  );

  if (opts.json) {
    renderStatusJson(results);
    return;
  }

  renderStatusTable(results, manifest);

  const goneRecords = results.filter((r) => r.liveState === "gone").map((r) => r.record);

  if (opts.prune && goneRecords.length > 0) {
    const s = p.spinner({
      output: process.stderr,
    });
    s.start(`Pruning ${goneRecords.length} gone server${goneRecords.length !== 1 ? "s" : ""}...`);
    for (const record of goneRecords) {
      markRecordDeleted(record);
    }
    s.stop(`Pruned ${goneRecords.length} gone server${goneRecords.length !== 1 ? "s" : ""} from history.`);
  } else if (!opts.prune && goneRecords.length > 0) {
    p.log.info(
      pc.dim(
        `${goneRecords.length} server${goneRecords.length !== 1 ? "s" : ""} marked as gone. Run ${pc.cyan("spawn status --prune")} to remove them.`,
      ),
    );
  }

  const unknown = results.filter((r) => r.liveState === "unknown");
  if (unknown.length > 0) {
    const clouds = [
      ...new Set(unknown.map((r) => r.record.cloud)),
    ].join(", ");
    p.log.info(
      pc.dim(
        `${unknown.length} server${unknown.length !== 1 ? "s" : ""} on ${clouds}: live check not supported (credentials not found or cloud not yet supported).`,
      ),
    );
  }

  const unreachable = results.filter((r) => r.agentAlive === false);
  if (unreachable.length > 0) {
    p.log.info(
      pc.dim(
        `${unreachable.length} server${unreachable.length !== 1 ? "s" : ""} running but agent unreachable. The agent may have crashed or still be starting.`,
      ),
    );
  }

  const running = results.filter((r) => r.liveState === "running").length;
  if (running > 0) {
    p.log.info(
      pc.dim(`${running} server${running !== 1 ? "s" : ""} running. Use ${pc.cyan("spawn list")} to reconnect.`),
    );
  }
}
