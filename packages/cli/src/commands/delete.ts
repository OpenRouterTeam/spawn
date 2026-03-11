import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import { authenticate as awsAuthenticate, destroyServer as awsDestroyServer, ensureAwsCli } from "../aws/aws.js";
import { destroyServer as doDestroyServer, ensureDoToken } from "../digitalocean/digitalocean.js";
import {
  authenticate as gcpAuthenticate,
  destroyInstance as gcpDestroyInstance,
  ensureGcloudCli as gcpEnsureGcloudCli,
  resolveProject as gcpResolveProject,
} from "../gcp/gcp.js";
import { ensureHcloudToken, destroyServer as hetznerDestroyServer } from "../hetzner/hetzner.js";
import { getActiveServers, markRecordDeleted } from "../history.js";
import { loadManifest } from "../manifest.js";
import { validateMetadataValue, validateServerIdentifier } from "../security.js";
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
      validateMetadataValue(zone, "GCP zone");
      if (project) {
        validateMetadataValue(project, "GCP project");
      }
      process.env.GCP_ZONE = zone;
      if (project) {
        process.env.GCP_PROJECT = project;
      }
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
        const resolveResult = await asyncTryCatch(() => gcpResolveProject());
        if (prevNonInteractive === undefined) {
          delete process.env.SPAWN_NON_INTERACTIVE;
        } else {
          process.env.SPAWN_NON_INTERACTIVE = prevNonInteractive;
        }
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

  // Ensure credentials before starting the spinner so interactive
  // prompts (e.g. expired API key entry) don't overlap with it.
  await ensureDeleteCredentials(record);

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
      p.log.info(`Run ${pc.cyan("spawn delete")} without filters to see all servers.`);
    } else {
      p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create a spawn first.`);
    }
    return;
  }

  const manifestResult = await asyncTryCatchIf(isNetworkError, loadManifest);
  const manifest: Manifest | null = manifestResult.ok ? manifestResult.data : null;

  if (!isInteractiveTTY()) {
    p.log.error("spawn delete requires an interactive terminal.");
    p.log.info(`Use ${pc.cyan("spawn list")} to see your servers.`);
    process.exit(1);
  }

  await activeServerPicker(filtered, manifest);
}
