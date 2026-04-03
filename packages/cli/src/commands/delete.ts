import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import { isString } from "@openrouter/spawn-shared";
import pc from "picocolors";
import * as v from "valibot";
import { authenticate as awsAuthenticate, destroyServer as awsDestroyServer, ensureAwsCli } from "../aws/aws.js";
import { destroyServer as doDestroyServer, ensureDoToken } from "../digitalocean/digitalocean.js";
import {
  authenticate as gcpAuthenticate,
  destroyInstance as gcpDestroyInstance,
  ensureGcloudCli as gcpEnsureGcloudCli,
  resolveProject as gcpResolveProject,
} from "../gcp/gcp.js";
import { ensureHcloudToken, destroyServer as hetznerDestroyServer } from "../hetzner/hetzner.js";
import { getActiveServers, loadHistory, markRecordDeleted, mergeChildHistory, SpawnRecordSchema } from "../history.js";
import { loadManifest } from "../manifest.js";
import {
  validateConnectionIP,
  validateMetadataValue,
  validateServerIdentifier,
  validateUsername,
} from "../security.js";
import { getHistoryPath } from "../shared/paths.js";
import { asyncTryCatch, asyncTryCatchIf, isNetworkError, tryCatch } from "../shared/result.js";
import { ensureSpriteAuthenticated, ensureSpriteCli, destroyServer as spriteDestroyServer } from "../sprite/sprite.js";
import { activeServerPicker, resolveListFilters } from "./list.js";
import { getErrorMessage, isInteractiveTTY } from "./shared.js";

/**
 * Ensure credentials are available for a record's cloud provider.
 * This may prompt the user interactively and must be called BEFORE
 * starting any spinner to avoid overlapping UI elements.
 */
async function ensureDeleteCredentials(record: SpawnRecord): Promise<void> {
  const conn = record.connection;
  if (!conn?.cloud || conn.cloud === "local") {
    return;
  }

  switch (conn.cloud) {
    case "hetzner":
      await ensureHcloudToken();
      break;
    case "digitalocean":
      await ensureDoToken();
      break;
    case "gcp": {
      const zone = conn.metadata?.zone || "us-central1-a";
      const project = conn.metadata?.project || "";
      if (!project) {
        throw new Error(
          "Cannot determine GCP project for this instance.\n\n" +
            "The history entry is missing project metadata. Without it, deletion\n" +
            "could target the wrong project.\n\n" +
            "To fix: delete the instance manually from the GCP Console:\n" +
            "  https://console.cloud.google.com/compute/instances",
        );
      }
      validateMetadataValue(zone, "GCP zone");
      validateMetadataValue(project, "GCP project");
      process.env.GCP_ZONE = zone;
      process.env.GCP_PROJECT = project;
      await gcpEnsureGcloudCli();
      await gcpAuthenticate();
      break;
    }
    case "aws":
      await ensureAwsCli();
      await awsAuthenticate();
      break;
    case "sprite":
      await ensureSpriteCli();
      await ensureSpriteAuthenticated();
      break;
    case "daytona": {
      const { ensureDaytonaAuthenticated, validateDaytonaConnection } = await import("../daytona/daytona.js");
      validateDaytonaConnection(conn);
      await ensureDaytonaAuthenticated();
      break;
    }
    default:
      break;
  }
}

/** Execute server deletion for a given record using TypeScript cloud modules */
async function execDeleteServer(record: SpawnRecord): Promise<boolean> {
  const conn = record.connection;
  if (!conn?.cloud || conn.cloud === "local") {
    return false;
  }

  const id = conn.server_id || conn.server_name || "";

  // SECURITY: Validate server ID to prevent command injection
  // This protects against corrupted or tampered history files
  const idValidation = tryCatch(() => validateServerIdentifier(id));
  if (!idValidation.ok) {
    throw new Error(
      `Invalid server identifier in history: ${getErrorMessage(idValidation.error)}\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `Location: ${getHistoryPath()}\n` +
        "To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'",
    );
  }

  const isAlreadyGone = (msg: string) =>
    msg.includes("404") || msg.includes("not found") || msg.includes("Not Found") || msg.includes("Could not find");

  const tryDelete = async (deleteFn: () => Promise<void>): Promise<boolean> => {
    const r = await asyncTryCatch(deleteFn);
    if (r.ok) {
      markRecordDeleted(record);
      return true;
    }
    const errMsg = getErrorMessage(r.error);
    if (isAlreadyGone(errMsg)) {
      p.log.warn("Server already deleted or not found. Marking as deleted.");
      markRecordDeleted(record);
      return true;
    }
    p.log.error(`Delete failed: ${errMsg}`);
    p.log.info("The server may still be running. Check your cloud provider dashboard.");
    return false;
  };

  switch (conn.cloud) {
    case "hetzner":
      return tryDelete(async () => {
        await ensureHcloudToken();
        await hetznerDestroyServer(id);
      });

    case "digitalocean":
      return tryDelete(async () => {
        await ensureDoToken();
        await doDestroyServer(id);
      });

    case "gcp": {
      const zone = conn.metadata?.zone || "us-central1-a";
      const project = conn.metadata?.project || "";
      if (!project) {
        throw new Error(
          "Cannot determine GCP project for this instance.\n\n" +
            "The history entry is missing project metadata. Without it, deletion\n" +
            "could target the wrong project.\n\n" +
            "To fix: delete the instance manually from the GCP Console:\n" +
            "  https://console.cloud.google.com/compute/instances",
        );
      }
      // SECURITY: Validate metadata values to prevent injection via tampered history
      validateMetadataValue(zone, "GCP zone");
      validateMetadataValue(project, "GCP project");
      return tryDelete(async () => {
        process.env.GCP_ZONE = zone;
        process.env.GCP_PROJECT = project;
        await gcpEnsureGcloudCli();
        await gcpAuthenticate();
        // resolveProject reads GCP_PROJECT directly — no fallback needed
        const resolveResult = await asyncTryCatch(() => gcpResolveProject());
        if (!resolveResult.ok) {
          throw resolveResult.error;
        }
        await gcpDestroyInstance(id);
      });
    }

    case "aws":
      return tryDelete(async () => {
        await ensureAwsCli();
        await awsAuthenticate();
        await awsDestroyServer(id);
      });

    case "sprite":
      return tryDelete(async () => {
        await ensureSpriteCli();
        await ensureSpriteAuthenticated();
        await spriteDestroyServer(id);
      });

    case "daytona":
      return tryDelete(async () => {
        const {
          destroyServer: daytonaDestroyServer,
          ensureDaytonaAuthenticated,
          validateDaytonaConnection,
        } = await import("../daytona/daytona.js");
        validateDaytonaConnection(conn);
        await ensureDaytonaAuthenticated();
        await daytonaDestroyServer(id);
      });

    default:
      p.log.error(`No delete handler for cloud: ${conn.cloud}`);
      return false;
  }
}

/** Prompt for delete confirmation and execute. Returns true if deleted. */
export async function confirmAndDelete(
  record: SpawnRecord,
  manifest: Manifest | null,
  deleteHandler?: (record: SpawnRecord) => Promise<boolean>,
): Promise<boolean> {
  const conn = record.connection!;
  const label = conn.server_name || conn.server_id || conn.ip;
  const cloudLabel = manifest?.clouds[conn.cloud!]?.name || conn.cloud;

  const confirmed = await p.confirm({
    message: `Delete server "${label}" on ${cloudLabel}? This will permanently destroy the server and all data on it.`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info("Delete cancelled.");
    return false;
  }

  // Ensure credentials before starting the spinner so interactive
  // prompts (e.g. expired API key entry) don't overlap with it.
  // Skip when a custom deleteHandler is provided (it manages its own deps).
  if (!deleteHandler) {
    await ensureDeleteCredentials(record);
  }

  const s = p.spinner({
    output: process.stderr,
  });
  s.start(`Deleting ${label}...`);

  // Cloud destroy functions log progress to stderr (logStep/logInfo).
  // Redirect those writes into s.message() so the spinner text updates
  // in place, then clear the spinner and replay the final message as a
  // normal log line so no spinner chrome remains in the terminal.
  const origStderrWrite = process.stderr.write;
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  let lastMessage = "";
  process.stderr.write = function stderrToSpinner(chunk: string | Uint8Array) {
    const text = isString(chunk) ? chunk : "";
    const stripped = text.replace(ANSI_RE, "").trim();
    if (stripped) {
      lastMessage = stripped;
      s.message(stripped);
    }
    return true;
  };

  const deleteFn = deleteHandler ?? execDeleteServer;
  const deleteResult = await asyncTryCatch(() => deleteFn(record));
  process.stderr.write = origStderrWrite;

  const success = deleteResult.ok ? deleteResult.data : false;

  s.clear();
  if (success) {
    const detail = lastMessage ? `: ${lastMessage}` : "";
    p.log.success(`Server "${label}" deleted${detail}`);
  } else {
    const detail = lastMessage ? `: ${lastMessage}` : "";
    p.log.error(`Failed to delete "${label}"${detail}`);
  }
  return success;
}

/** Pull child history from a remote VM via SSH before deleting it. */
export async function pullChildHistory(record: SpawnRecord): Promise<void> {
  const conn = record.connection;
  if (!conn?.ip || !conn.user || conn.cloud === "local" || conn.ip === "sprite-console") {
    return;
  }

  const connValidation = tryCatch(() => {
    validateUsername(conn.user);
    validateConnectionIP(conn.ip);
  });
  if (!connValidation.ok) {
    return;
  }

  const { ensureSshKeys, getSshKeyOpts } = await import("../shared/ssh-keys.js");
  const { SSH_BASE_OPTS } = await import("../shared/ssh.js");

  const pullResult = await asyncTryCatch(async () => {
    const keys = await ensureSshKeys();
    const keyOpts = getSshKeyOpts(keys);
    const proc = Bun.spawn(
      [
        "ssh",
        ...SSH_BASE_OPTS,
        ...keyOpts,
        `${conn.user}@${conn.ip}`,
        "spawn history export 2>/dev/null",
      ],
      {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim();
  });

  if (!pullResult.ok || !pullResult.data) {
    // Non-fatal: VM might already be unreachable
    return;
  }

  await asyncTryCatch(async () => {
    const parsed: unknown = JSON.parse(pullResult.data);
    if (!Array.isArray(parsed)) {
      return;
    }
    const childRecords: SpawnRecord[] = [];
    for (const el of parsed) {
      const result = v.safeParse(SpawnRecordSchema, el);
      if (result.success) {
        childRecords.push(result.output);
      }
    }
    if (childRecords.length > 0) {
      mergeChildHistory(record.id, childRecords);
      p.log.info(`Merged ${childRecords.length} child record(s) from ${conn.server_name || conn.ip}`);
    }
  });
}

/** Find all children of a given spawn record (direct and transitive). */
export function findDescendants(parentId: string): SpawnRecord[] {
  const history = loadHistory();
  const descendants: SpawnRecord[] = [];
  const queue = [
    parentId,
  ];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const r of history) {
      if (r.parent_id === currentId && !r.connection?.deleted) {
        descendants.push(r);
        queue.push(r.id);
      }
    }
  }

  return descendants;
}

/** Delete a spawn and all its descendants (depth-first). */
export async function cascadeDelete(record: SpawnRecord, manifest: Manifest | null): Promise<boolean> {
  const descendants = findDescendants(record.id);

  if (descendants.length > 0) {
    const totalCount = descendants.length + 1;
    const confirmed = await p.confirm({
      message: `This will delete ${totalCount} server(s) (1 parent + ${descendants.length} child${descendants.length !== 1 ? "ren" : ""}). Continue?`,
      initialValue: false,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.log.info("Cascade delete cancelled.");
      return false;
    }

    // Delete children first (depth-first by reversing — deepest children last in queue, first to delete)
    descendants.reverse();
    for (const child of descendants) {
      if (!child.connection?.deleted) {
        p.log.step(`Deleting child: ${child.connection?.server_name || child.id}`);
        await pullChildHistory(child);
        await execDeleteServer(child);
      }
    }
  }

  // Delete the parent
  await pullChildHistory(record);
  return confirmAndDelete(record, manifest);
}

export async function cmdDelete(
  agentFilter?: string,
  cloudFilter?: string,
  nameFilter?: string,
  forceYes?: boolean,
): Promise<void> {
  const resolved = await resolveListFilters(agentFilter, cloudFilter);
  agentFilter = resolved.agentFilter;
  cloudFilter = resolved.cloudFilter;

  const servers = getActiveServers();

  let filtered = servers;
  if (agentFilter) {
    const lower = agentFilter.toLowerCase();
    filtered = filtered.filter((r) => r.agent.toLowerCase() === lower);
  }
  if (cloudFilter) {
    const lower = cloudFilter.toLowerCase();
    filtered = filtered.filter((r) => r.cloud.toLowerCase() === lower);
  }
  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        (r.name ?? "").toLowerCase() === lower ||
        (r.connection?.server_name ?? "").toLowerCase() === lower ||
        r.id === nameFilter,
    );
  }

  if (filtered.length === 0) {
    p.log.info("No active servers to delete.");
    if (servers.length > 0) {
      p.log.info(
        pc.dim(
          `${servers.length} active server${servers.length !== 1 ? "s" : ""} found, but none matched your filters.`,
        ),
      );
      p.log.info(`Run ${pc.cyan("spawn delete")} without filters to see all servers.`);
    } else {
      p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create a spawn first.`);
    }
    return;
  }

  const manifestResult = await asyncTryCatchIf(isNetworkError, loadManifest);
  const manifest: Manifest | null = manifestResult.ok ? manifestResult.data : null;

  // Non-interactive headless delete: --name + --yes skips the picker
  if (!isInteractiveTTY()) {
    if (!forceYes) {
      p.log.error("spawn delete requires --yes in non-interactive mode.");
      p.log.info(`Usage: ${pc.cyan("spawn delete --name <name> --yes")}`);
      process.exit(1);
    }
    for (const record of filtered) {
      const label = record.connection?.server_name || record.name || record.id;
      await ensureDeleteCredentials(record);
      const ok = await execDeleteServer(record);
      if (ok) {
        p.log.success(`Server "${label}" deleted`);
      }
    }
    return;
  }

  await activeServerPicker(filtered, manifest);
}
