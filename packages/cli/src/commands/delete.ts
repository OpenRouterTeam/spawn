import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Manifest } from "../manifest.js";
import { loadManifest } from "../manifest.js";
import type { SpawnRecord } from "../history.js";
import { getActiveServers, markRecordDeleted, getHistoryPath } from "../history.js";
import { validateServerIdentifier, validateMetadataValue } from "../security.js";
import { destroyServer as hetznerDestroyServer, ensureHcloudToken } from "../hetzner/hetzner.js";
import { destroyServer as doDestroyServer, ensureDoToken } from "../digitalocean/digitalocean.js";
import {
  destroyInstance as gcpDestroyInstance,
  ensureGcloudCli as gcpEnsureGcloudCli,
  authenticate as gcpAuthenticate,
  resolveProject as gcpResolveProject,
} from "../gcp/gcp.js";
import { destroyServer as awsDestroyServer, ensureAwsCli, authenticate as awsAuthenticate } from "../aws/aws.js";
import { destroyServer as daytonaDestroyServer, ensureDaytonaToken } from "../daytona/daytona.js";
import { destroyServer as spriteDestroyServer, ensureSpriteCli, ensureSpriteAuthenticated } from "../sprite/sprite.js";
import { getErrorMessage, isInteractiveTTY } from "./shared.js";
import { resolveListFilters, activeServerPicker } from "./list.js";

/** Execute server deletion for a given record using TypeScript cloud modules */
export async function execDeleteServer(record: SpawnRecord): Promise<boolean> {
  const conn = record.connection;
  if (!conn?.cloud || conn.cloud === "local") {
    return false;
  }

  const id = conn.server_id || conn.server_name || "";

  // SECURITY: Validate server ID to prevent command injection
  // This protects against corrupted or tampered history files
  try {
    validateServerIdentifier(id);
  } catch (err) {
    throw new Error(
      `Invalid server identifier in history: ${getErrorMessage(err)}\n\n` +
        "Your spawn history file may be corrupted or tampered with.\n" +
        `Location: ${getHistoryPath()}\n` +
        "To fix: edit the file and remove the invalid entry, or run 'spawn list --clear'",
    );
  }

  const isAlreadyGone = (msg: string) =>
    msg.includes("404") || msg.includes("not found") || msg.includes("Not Found") || msg.includes("Could not find");

  const tryDelete = async (deleteFn: () => Promise<void>): Promise<boolean> => {
    try {
      await deleteFn();
      markRecordDeleted(record);
      return true;
    } catch (err) {
      const errMsg = getErrorMessage(err);
      if (isAlreadyGone(errMsg)) {
        p.log.warn("Server already deleted or not found. Marking as deleted.");
        markRecordDeleted(record);
        return true;
      }
      p.log.error(`Delete failed: ${errMsg}`);
      p.log.info("The server may still be running. Check your cloud provider dashboard.");
      return false;
    }
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
      // SECURITY: Validate metadata values to prevent injection via tampered history
      validateMetadataValue(zone, "GCP zone");
      if (project) {
        validateMetadataValue(project, "GCP project");
      }
      return tryDelete(async () => {
        process.env.GCP_ZONE = zone;
        if (project) {
          process.env.GCP_PROJECT = project;
        }
        await gcpEnsureGcloudCli();
        await gcpAuthenticate();
        // Deletion runs under a spinner — suppress interactive prompts
        const prevNonInteractive = process.env.SPAWN_NON_INTERACTIVE;
        process.env.SPAWN_NON_INTERACTIVE = "1";
        try {
          await gcpResolveProject();
        } finally {
          if (prevNonInteractive === undefined) {
            delete process.env.SPAWN_NON_INTERACTIVE;
          } else {
            process.env.SPAWN_NON_INTERACTIVE = prevNonInteractive;
          }
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

    case "daytona":
      return tryDelete(async () => {
        await ensureDaytonaToken();
        await daytonaDestroyServer(id);
      });

    case "sprite":
      return tryDelete(async () => {
        await ensureSpriteCli();
        await ensureSpriteAuthenticated();
        await spriteDestroyServer(id);
      });

    default:
      p.log.error(`No delete handler for cloud: ${conn.cloud}`);
      return false;
  }
}

/** Prompt for delete confirmation and execute. Returns true if deleted. */
export async function confirmAndDelete(record: SpawnRecord, manifest: Manifest | null): Promise<boolean> {
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

  const s = p.spinner();
  s.start(`Deleting ${label}...`);

  const success = await execDeleteServer(record);

  if (success) {
    s.stop(`Server "${label}" deleted.`);
  } else {
    s.stop("Delete failed.");
  }
  return success;
}

export async function cmdDelete(agentFilter?: string, cloudFilter?: string): Promise<void> {
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

  if (filtered.length === 0) {
    p.log.info("No active servers to delete.");
    if (servers.length > 0) {
      p.log.info(
        pc.dim(
          `${servers.length} active server${servers.length !== 1 ? "s" : ""} found, but none matched your filters.`,
        ),
      );
    }
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create a spawn first.`);
    return;
  }

  let manifest: Manifest | null = null;
  try {
    manifest = await loadManifest();
  } catch {
    // Manifest unavailable
  }

  if (!isInteractiveTTY()) {
    p.log.error("spawn delete requires an interactive terminal.");
    p.log.info(`Use ${pc.cyan("spawn list")} to see your servers.`);
    process.exit(1);
  }

  await activeServerPicker(filtered, manifest);
}
