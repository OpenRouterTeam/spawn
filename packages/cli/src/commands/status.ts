import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import { filterHistory, markRecordDeleted } from "../history.js";
import { loadManifest } from "../manifest.js";
import { parseJsonObj } from "../shared/parse.js";
import { isString, toRecord } from "../shared/type-guards.js";
import { loadApiToken } from "../shared/ui.js";
import { formatRelativeTime } from "./list.js";
import { resolveDisplayName } from "./shared.js";

// ── Types ────────────────────────────────────────────────────────────────────

type LiveState = "running" | "stopped" | "gone" | "unknown";

interface ServerStatusResult {
  record: SpawnRecord;
  liveState: LiveState;
}

interface JsonStatusEntry {
  id: string;
  agent: string;
  cloud: string;
  ip: string;
  name: string;
  state: LiveState;
  spawned_at: string;
  server_id: string;
}

// ── Cloud status fetchers ────────────────────────────────────────────────────

async function fetchHetznerStatus(serverId: string, token: string): Promise<LiveState> {
  try {
    const resp = await fetch(`https://api.hetzner.cloud/v1/servers/${serverId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 404) {
      return "gone";
    }
    if (!resp.ok) {
      return "unknown";
    }
    const text = await resp.text();
    const data = parseJsonObj(text);
    const server = toRecord(data?.server);
    const serverStatus = server?.status;
    if (!isString(serverStatus)) {
      return "unknown";
    }
    if (serverStatus === "running") {
      return "running";
    }
    if (serverStatus === "off") {
      return "stopped";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchDoStatus(dropletId: string, token: string): Promise<LiveState> {
  try {
    const resp = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 404) {
      return "gone";
    }
    if (!resp.ok) {
      return "unknown";
    }
    const text = await resp.text();
    const data = parseJsonObj(text);
    const droplet = toRecord(data?.droplet);
    const dropletStatus = droplet?.status;
    if (!isString(dropletStatus)) {
      return "unknown";
    }
    if (dropletStatus === "active") {
      return "running";
    }
    if (dropletStatus === "off" || dropletStatus === "archive") {
      return "stopped";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
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

    default:
      // Other clouds (aws, gcp, sprite) require CLI or complex auth;
      // report "unknown" rather than attempting a potentially interactive flow.
      return "unknown";
  }
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
  const COL_SINCE = 12;

  const header = [
    col(pc.dim("ID"), COL_ID),
    col(pc.dim("Agent"), COL_AGENT),
    col(pc.dim("Cloud"), COL_CLOUD),
    col(pc.dim("IP"), COL_IP),
    col(pc.dim("State"), COL_STATE),
    pc.dim("Since"),
  ].join(" ");

  const divider = pc.dim(
    [
      "-".repeat(COL_ID),
      "-".repeat(COL_AGENT),
      "-".repeat(COL_CLOUD),
      "-".repeat(COL_IP),
      "-".repeat(COL_STATE),
      "-".repeat(COL_SINCE),
    ].join("-"),
  );

  console.log();
  console.log(header);
  console.log(divider);

  for (const { record, liveState } of results) {
    const conn = record.connection;
    const shortId = record.id ? record.id.slice(0, 6) : "??????";
    const agentDisplay = resolveDisplayName(manifest, record.agent, "agent");
    const cloudDisplay = resolveDisplayName(manifest, record.cloud, "cloud");
    const ip = fmtIp(conn);
    const state = fmtState(liveState);
    const since = formatRelativeTime(record.timestamp);

    const row = [
      col(pc.dim(shortId), COL_ID),
      col(agentDisplay, COL_AGENT),
      col(cloudDisplay, COL_CLOUD),
      col(ip, COL_IP),
      col(state, COL_STATE),
      pc.dim(since),
    ].join(" ");

    console.log(row);
  }

  console.log();
}

// ── JSON output ──────────────────────────────────────────────────────────────

function renderStatusJson(results: ServerStatusResult[]): void {
  const entries: JsonStatusEntry[] = results.map(({ record, liveState }) => ({
    id: record.id || "",
    agent: record.agent,
    cloud: record.cloud,
    ip: fmtIp(record.connection),
    name: record.name || record.connection?.server_name || "",
    state: liveState,
    spawned_at: record.timestamp,
    server_id: record.connection?.server_id || record.connection?.server_name || "",
  }));
  console.log(JSON.stringify(entries, null, 2));
}

// ── Main command ─────────────────────────────────────────────────────────────

export async function cmdStatus(
  opts: { prune?: boolean; json?: boolean; agentFilter?: string; cloudFilter?: string } = {},
): Promise<void> {
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

  let manifest: Manifest | null = null;
  try {
    manifest = await loadManifest();
  } catch {
    // Manifest unavailable — show raw keys
  }

  if (!opts.json) {
    p.log.step(`Checking status of ${candidates.length} server${candidates.length !== 1 ? "s" : ""}...`);
  }

  const results: ServerStatusResult[] = await Promise.all(
    candidates.map(async (record) => {
      const liveState = await checkServerStatus(record);
      return {
        record,
        liveState,
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
    const s = p.spinner();
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

  const running = results.filter((r) => r.liveState === "running").length;
  if (running > 0) {
    p.log.info(
      pc.dim(`${running} server${running !== 1 ? "s" : ""} running. Use ${pc.cyan("spawn list")} to reconnect.`),
    );
  }
}
