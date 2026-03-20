import type { ValueOf } from "@openrouter/spawn-shared";
import type { CloudInstance, SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  clearHistory,
  filterHistory,
  getActiveServers,
  markRecordDeleted,
  removeRecord,
  updateRecordConnection,
  updateRecordIp,
} from "../history.js";
import { agentKeys, cloudKeys, loadManifest } from "../manifest.js";
import { asyncTryCatch, tryCatch, unwrapOr } from "../shared/result.js";
import { cmdConnect, cmdEnterAgent, cmdOpenDashboard } from "./connect.js";
import { confirmAndDelete } from "./delete.js";
import { fixSpawn } from "./fix.js";
import { cmdRun } from "./run.js";
import {
  buildRetryCommand,
  findClosestKeyByNameOrKey,
  getErrorMessage,
  handleCancel,
  isInteractiveTTY,
  resolveAgentKey,
  resolveCloudKey,
  resolveDisplayName,
} from "./shared.js";

// ── Formatting helpers ───────────────────────────────────────────────────────

/** Format an ISO timestamp as a human-readable relative time (e.g., "5 min ago", "2 days ago") */
export function formatRelativeTime(iso: string): string {
  return unwrapOr(
    tryCatch(() => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) {
        return iso;
      }
      const diffMs = Date.now() - d.getTime();
      if (diffMs < 0) {
        return "just now";
      }
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 60) {
        return "just now";
      }
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        return `${diffMin} min ago`;
      }
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) {
        return `${diffHr}h ago`;
      }
      const diffDays = Math.floor(diffHr / 24);
      if (diffDays === 1) {
        return "yesterday";
      }
      if (diffDays < 30) {
        return `${diffDays}d ago`;
      }
      // Fall back to absolute date for old entries
      const date = d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      return date;
    }),
    iso,
  );
}

/** Build a display label (line 1: name) for a spawn record in the interactive picker */
export function buildRecordLabel(r: SpawnRecord): string {
  return r.name || r.connection?.server_name || "unnamed";
}

/** Build a subtitle (line 2: agent + cloud + time) for the interactive picker */
export function buildRecordSubtitle(r: SpawnRecord, manifest: Manifest | null): string {
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  const relative = formatRelativeTime(r.timestamp);
  const parts = [
    agentDisplay,
    cloudDisplay,
    relative,
  ];
  if (r.connection?.deleted) {
    parts.push("[deleted]");
  }
  return parts.join(" \u00b7 ");
}

// ── Filter resolution ────────────────────────────────────────────────────────

async function suggestFilterCorrection(
  filter: string,
  flag: string,
  keys: string[],
  resolveKey: (m: Manifest, input: string) => string | null,
  getDisplayName: (k: string) => string,
  manifest: Manifest,
): Promise<void> {
  const resolved = resolveKey(manifest, filter);
  if (resolved && resolved !== filter) {
    p.log.info(`Did you mean ${pc.cyan(`spawn list ${flag} ${resolved}`)}?`);
  } else if (!resolved) {
    const match = findClosestKeyByNameOrKey(filter, keys, getDisplayName);
    if (match) {
      p.log.info(`Did you mean ${pc.cyan(`spawn list ${flag} ${match}`)}?`);
    }
  }
}

async function showEmptyListMessage(agentFilter?: string, cloudFilter?: string): Promise<void> {
  if (!agentFilter && !cloudFilter) {
    p.log.info("No spawns recorded yet.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to launch your first agent.`);
    return;
  }

  const parts: string[] = [];
  if (agentFilter) {
    parts.push(`agent=${pc.bold(agentFilter)}`);
  }
  if (cloudFilter) {
    parts.push(`cloud=${pc.bold(cloudFilter)}`);
  }
  p.log.info(`No spawns found matching ${parts.join(", ")}.`);

  const manifestResult = await asyncTryCatch(() => loadManifest());
  if (manifestResult.ok) {
    const manifest = manifestResult.data;
    if (agentFilter) {
      await suggestFilterCorrection(
        agentFilter,
        "-a",
        agentKeys(manifest),
        resolveAgentKey,
        (k) => manifest.agents[k].name,
        manifest,
      );
    }
    if (cloudFilter) {
      await suggestFilterCorrection(
        cloudFilter,
        "-c",
        cloudKeys(manifest),
        resolveCloudKey,
        (k) => manifest.clouds[k].name,
        manifest,
      );
    }
  }

  const totalRecords = filterHistory();
  if (totalRecords.length > 0) {
    p.log.info(
      `Run ${pc.cyan("spawn list")} to see all ${totalRecords.length} recorded spawn${totalRecords.length !== 1 ? "s" : ""}.`,
    );
  }
}

// ── List display ─────────────────────────────────────────────────────────────

function buildListFooterLines(records: SpawnRecord[], agentFilter?: string, cloudFilter?: string): string[] {
  const lines: string[] = [];
  const latest = records[0];
  lines.push(`Rerun last: ${pc.cyan(buildRetryCommand(latest.agent, latest.cloud, latest.prompt, latest.name))}`);

  if (agentFilter || cloudFilter) {
    const totalRecords = filterHistory();
    lines.push(
      pc.dim(`Showing ${records.length} of ${totalRecords.length} spawn${totalRecords.length !== 1 ? "s" : ""}`),
    );
    lines.push(pc.dim(`Clear filter: ${pc.cyan("spawn list")}`));
  } else {
    lines.push(pc.dim(`${records.length} spawn${records.length !== 1 ? "s" : ""} recorded`));
    lines.push(
      pc.dim(
        `Filter: ${pc.cyan("spawn list -a <agent>")}  or  ${pc.cyan("spawn list -c <cloud>")}  |  Clear: ${pc.cyan("spawn list --clear")}`,
      ),
    );
  }
  return lines;
}

function showListFooter(records: SpawnRecord[], agentFilter?: string, cloudFilter?: string): void {
  for (const line of buildListFooterLines(records, agentFilter, cloudFilter)) {
    console.log(line);
  }
  console.log();
}

function renderListTable(records: SpawnRecord[], manifest: Manifest | null): void {
  console.log();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const name = r.name || r.connection?.server_name || "unnamed";
    console.log(pc.bold(name));
    console.log(pc.dim(`  ${buildRecordSubtitle(r, manifest)}`));
    if (i < records.length - 1) {
      console.log();
    }
  }
  console.log();
}

/** Try to load manifest and resolve filter display names to keys.
 *  When a bare positional filter doesn't match an agent, try it as a cloud. */
export async function resolveListFilters(
  agentFilter?: string,
  cloudFilter?: string,
): Promise<{
  manifest: Manifest | null;
  agentFilter?: string;
  cloudFilter?: string;
}> {
  const manifestResult = await asyncTryCatch(() => loadManifest());
  const manifest: Manifest | null = manifestResult.ok ? manifestResult.data : null;

  if (manifest && agentFilter) {
    const resolved = resolveAgentKey(manifest, agentFilter);
    if (resolved) {
      agentFilter = resolved;
    } else if (!cloudFilter) {
      // Bare positional arg didn't match an agent -- try as a cloud filter
      const resolvedCloud = resolveCloudKey(manifest, agentFilter);
      if (resolvedCloud) {
        cloudFilter = resolvedCloud;
        agentFilter = undefined;
      }
    }
  }
  if (manifest && cloudFilter) {
    const resolved = resolveCloudKey(manifest, cloudFilter);
    if (resolved) {
      cloudFilter = resolved;
    }
  }

  return {
    manifest,
    agentFilter,
    cloudFilter,
  };
}

// ── Gone server handling ────────────────────────────────────────────────────

/** Fetch live instances from a cloud provider. */
async function fetchCloudInstances(cloud: string, record: SpawnRecord): Promise<CloudInstance[]> {
  switch (cloud) {
    case "hetzner": {
      const { listServers } = await import("../hetzner/hetzner.js");
      return listServers();
    }
    case "digitalocean": {
      const { listServers } = await import("../digitalocean/digitalocean.js");
      return listServers();
    }
    case "aws": {
      const { listServers } = await import("../aws/aws.js");
      return listServers();
    }
    case "gcp": {
      const zone = record.connection?.metadata?.zone || "us-central1-a";
      const project = record.connection?.metadata?.project || "";
      if (!project) {
        return [];
      }
      const { listServers } = await import("../gcp/gcp.js");
      return listServers(zone, project);
    }
    default:
      return [];
  }
}

/**
 * Handle a server that no longer exists on the cloud provider.
 * Offers the user a choice: remap to an existing instance, delete from history, or cancel.
 * In non-interactive mode, falls back to silent deletion (previous behavior).
 */
async function handleGoneServer(record: SpawnRecord, cloud: string): Promise<"deleted" | "remapped" | "cancelled"> {
  p.log.warn("Server no longer exists on the cloud provider.");

  // Non-interactive: fall back to silent deletion
  if (process.env.SPAWN_NON_INTERACTIVE === "1" || !isInteractiveTTY()) {
    markRecordDeleted(record);
    if (record.connection) {
      record.connection.deleted = true;
    }
    return "deleted";
  }

  // Try to fetch live instances
  const instancesResult = await asyncTryCatch(() => fetchCloudInstances(cloud, record));
  const instances = instancesResult.ok ? instancesResult.data : [];

  const options: {
    value: string;
    label: string;
    hint?: string;
  }[] = [];

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    options.push({
      value: `remap-${i}`,
      label: `${inst.name} (${inst.ip || "no IP"})`,
      hint: inst.status,
    });
  }

  options.push({
    value: "delete",
    label: "Remove from history",
    hint: "mark this entry as deleted",
  });

  options.push({
    value: "cancel",
    label: "Cancel",
    hint: "go back without changes",
  });

  const action = await p.select({
    message:
      instances.length > 0
        ? "Remap to an existing instance or remove from history?"
        : "No live instances found. What would you like to do?",
    options,
  });

  if (p.isCancel(action) || action === "cancel") {
    return "cancelled";
  }

  if (action === "delete") {
    markRecordDeleted(record);
    if (record.connection) {
      record.connection.deleted = true;
    }
    p.log.success("Removed from history.");
    return "deleted";
  }

  // Remap to selected instance
  const actionStr = String(action);
  if (actionStr.startsWith("remap-")) {
    const idx = Number.parseInt(action.slice(6), 10);
    const inst = instances[idx];
    if (inst) {
      updateRecordConnection(record, {
        ip: inst.ip,
        server_id: inst.id,
        server_name: inst.name,
      });
      // Update in-memory connection too
      if (record.connection) {
        record.connection.ip = inst.ip;
        record.connection.server_id = inst.id;
        record.connection.server_name = inst.name;
      }
      p.log.success(`Remapped to ${inst.name} (${inst.ip})`);
      return "remapped";
    }
  }

  return "cancelled";
}

// ── IP refresh ──────────────────────────────────────────────────────────────

/**
 * Refresh the IP address for a connection by querying the cloud provider API.
 * Updates the in-memory connection object and persists the change to history.
 * Returns "ok" if the IP was refreshed (or unchanged), "gone" if the server
 * no longer exists, or "skip" if refresh is not applicable (local, sprite, etc.).
 */
async function refreshConnectionIp(record: SpawnRecord): Promise<"ok" | "gone" | "skip"> {
  const conn = record.connection;
  if (!conn?.cloud || conn.cloud === "local" || conn.cloud === "sprite" || conn.deleted) {
    return "skip";
  }

  const serverId = conn.server_id || conn.server_name || "";
  if (!serverId) {
    return "skip";
  }

  let currentIp: string | null = null;

  switch (conn.cloud) {
    case "digitalocean": {
      const { ensureDoToken, getServerIp } = await import("../digitalocean/digitalocean.js");
      await ensureDoToken();
      currentIp = await getServerIp(serverId);
      break;
    }
    case "hetzner": {
      const { ensureHcloudToken, getServerIp } = await import("../hetzner/hetzner.js");
      await ensureHcloudToken();
      currentIp = await getServerIp(serverId);
      break;
    }
    case "aws": {
      const { ensureAwsCli, authenticate, getServerIp } = await import("../aws/aws.js");
      await ensureAwsCli();
      await authenticate();
      currentIp = await getServerIp(serverId);
      break;
    }
    case "gcp": {
      const { ensureGcloudCli, authenticate, resolveProject, getServerIp } = await import("../gcp/gcp.js");
      const zone = conn.metadata?.zone || "us-central1-a";
      const project = conn.metadata?.project || "";
      if (!project) {
        return "skip";
      }
      process.env.GCP_ZONE = zone;
      process.env.GCP_PROJECT = project;
      await ensureGcloudCli();
      await authenticate();
      // Set SPAWN_NON_INTERACTIVE to suppress project prompt during refresh
      const prevNonInteractive = process.env.SPAWN_NON_INTERACTIVE;
      process.env.SPAWN_NON_INTERACTIVE = "1";
      const resolveResult = await asyncTryCatch(() => resolveProject());
      if (prevNonInteractive === undefined) {
        delete process.env.SPAWN_NON_INTERACTIVE;
      } else {
        process.env.SPAWN_NON_INTERACTIVE = prevNonInteractive;
      }
      if (!resolveResult.ok) {
        return "skip";
      }
      currentIp = await getServerIp(serverId, zone, project);
      break;
    }
    default:
      return "skip";
  }

  if (currentIp === null) {
    // Server no longer exists — let user decide
    const result = await handleGoneServer(record, conn.cloud);
    if (result === "remapped") {
      return "ok";
    }
    return "gone";
  }

  if (currentIp !== conn.ip) {
    p.log.info(`Server IP changed: ${conn.ip} -> ${currentIp}`);
    conn.ip = currentIp;
    updateRecordIp(record, currentIp);
  }

  return "ok";
}

// ── Record actions ───────────────────────────────────────────────────────────

/** Outcome of handleRecordAction — determines whether the picker loops or exits. */
export const RecordActionOutcome = {
  /** Navigate back to the server list (delete/remove/cancel). */
  Back: 0,
  /** Exit the picker (enter/reconnect/rerun). */
  Exit: 1,
} as const;

export type RecordActionOutcome = ValueOf<typeof RecordActionOutcome>;

/**
 * Handle reconnect or rerun action for a selected spawn record.
 * Returns Back if the picker should navigate back to the list (delete/remove),
 * or Exit for terminal actions (enter/reconnect/rerun) that exit the picker.
 */
export async function handleRecordAction(
  selected: SpawnRecord,
  manifest: Manifest | null,
): Promise<RecordActionOutcome> {
  if (!selected.connection) {
    // No connection info -- just rerun, reusing the existing spawn name
    if (selected.name) {
      process.env.SPAWN_NAME = selected.name;
    }
    p.log.step(`Spawning ${pc.bold(buildRecordLabel(selected))}`);
    await cmdRun(selected.agent, selected.cloud, selected.prompt);
    return RecordActionOutcome.Exit;
  }

  const conn = selected.connection;
  const canDelete = conn.cloud && conn.cloud !== "local" && !conn.deleted && (conn.server_id || conn.server_name);

  const options: {
    value: string;
    label: string;
    hint?: string;
  }[] = [];

  // Prefer stored launch command (captured at spawn time), fall back to manifest
  const agentDef = manifest?.agents?.[selected.agent];
  const launchCmd = conn.launch_cmd || agentDef?.launch;

  if (!conn.deleted && launchCmd) {
    const agentName = agentDef?.name || selected.agent;
    options.push({
      value: "enter",
      label: `Enter ${agentName}`,
      hint: agentDef?.launch || launchCmd,
    });
  }

  if (!conn.deleted && conn.metadata?.tunnel_remote_port) {
    options.push({
      value: "dashboard",
      label: "Open Dashboard",
      hint: "Open web dashboard in browser",
    });
  }

  if (!conn.deleted) {
    options.push({
      value: "reconnect",
      label: "SSH into VM",
      hint: conn.ip === "sprite-console" ? `sprite console -s ${conn.server_name}` : `ssh ${conn.user}@${conn.ip}`,
    });
  }

  options.push({
    value: "rerun",
    label: "Spawn a new VM",
    hint: "Create a fresh instance",
  });

  const canFix = !conn.deleted && conn.ip && conn.ip !== "sprite-console" && conn.user;
  if (canFix) {
    options.push({
      value: "fix",
      label: "Fix this server",
      hint: "Re-inject credentials and reinstall agent",
    });
  }

  if (canDelete) {
    options.push({
      value: "delete",
      label: "Delete this server",
      hint: `destroy ${conn.server_name || conn.server_id}`,
    });
  }

  options.push({
    value: "remove",
    label: "Remove from history",
    hint: "remove this entry only",
  });

  const action = await p.select({
    message: "What would you like to do?",
    options,
  });

  if (p.isCancel(action)) {
    return RecordActionOutcome.Back;
  }

  // Refresh IP from cloud API before connecting (enter/reconnect/fix)
  if (action === "enter" || action === "reconnect" || action === "fix") {
    const refreshResult = await asyncTryCatch(() => refreshConnectionIp(selected));
    if (refreshResult.ok && refreshResult.data === "gone") {
      p.log.info(`Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`);
      return RecordActionOutcome.Back;
    }
    if (!refreshResult.ok) {
      // Non-fatal: proceed with cached IP if refresh fails
      p.log.warn(`Could not refresh server IP: ${getErrorMessage(refreshResult.error)}`);
    }
  }

  if (action === "enter") {
    const enterResult = await asyncTryCatch(() => cmdEnterAgent(conn, selected.agent, manifest));
    if (!enterResult.ok) {
      p.log.error(`Connection failed: ${getErrorMessage(enterResult.error)}`);

      p.log.info(
        `VM may no longer be running. Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`,
      );
    }
    return RecordActionOutcome.Exit;
  }

  if (action === "dashboard") {
    const dashResult = await asyncTryCatch(() => cmdOpenDashboard(conn));
    if (!dashResult.ok) {
      p.log.error(`Dashboard failed: ${getErrorMessage(dashResult.error)}`);
    }
    return RecordActionOutcome.Back;
  }

  if (action === "reconnect") {
    const reconnectResult = await asyncTryCatch(() => cmdConnect(conn));
    if (!reconnectResult.ok) {
      p.log.error(`Connection failed: ${getErrorMessage(reconnectResult.error)}`);

      p.log.info(
        `VM may no longer be running. Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`,
      );
    }
    return RecordActionOutcome.Exit;
  }

  if (action === "fix") {
    await fixSpawn(selected, manifest);
    return RecordActionOutcome.Back;
  }

  if (action === "delete") {
    await confirmAndDelete(selected, manifest);
    return RecordActionOutcome.Back;
  }

  if (action === "remove") {
    const removed = removeRecord(selected);
    if (removed) {
      p.log.success("Removed from history.");
    } else {
      p.log.warn("Could not find record in history.");
    }
    return RecordActionOutcome.Back;
  }

  // Rerun (create new spawn).  Clear any pre-set name so the user is prompted for
  // a fresh one — this prevents cmdRun's duplicate-detection from immediately
  // routing them back here in an infinite loop.
  delete process.env.SPAWN_NAME;
  p.log.step(
    `Spawning ${pc.bold(buildRecordLabel(selected))} ${pc.dim(`(${buildRecordSubtitle(selected, manifest)})`)}`,
  );
  await cmdRun(selected.agent, selected.cloud, selected.prompt);
  return RecordActionOutcome.Exit;
}

/** Interactive picker with inline delete support.
 *  Pressing 'd' triggers delete; Enter triggers handleRecordAction. */
export async function activeServerPicker(records: SpawnRecord[], manifest: Manifest | null): Promise<void> {
  const { pickToTTYWithActions } = await import("../picker.js");

  const remaining = [
    ...records,
  ];

  while (remaining.length > 0) {
    const options = remaining.map((r) => ({
      value: r.timestamp,
      label: buildRecordLabel(r),
      subtitle: buildRecordSubtitle(r, manifest),
    }));

    const result = pickToTTYWithActions({
      message: `Select a spawn (${remaining.length} server${remaining.length !== 1 ? "s" : ""})`,
      options,
      deleteKey: true,
    });

    if (result.action === "cancel") {
      return;
    }

    const picked = remaining[result.index];

    if (result.action === "delete") {
      const conn = picked.connection;
      const canDestroy = conn?.cloud && conn.cloud !== "local" && !conn.deleted && (conn.server_id || conn.server_name);

      const deleteOptions: {
        value: string;
        label: string;
        hint?: string;
      }[] = [];
      if (canDestroy) {
        deleteOptions.push({
          value: "destroy",
          label: "Destroy server",
          hint: "permanently delete the cloud VM",
        });
      }
      deleteOptions.push({
        value: "remove",
        label: "Remove from history",
        hint: "remove this entry without touching the server",
      });
      deleteOptions.push({
        value: "cancel",
        label: "Cancel",
      });

      const deleteAction = await p.select({
        message: "How do you want to delete this?",
        options: deleteOptions,
      });

      if (p.isCancel(deleteAction) || deleteAction === "cancel") {
        continue;
      }

      if (deleteAction === "destroy") {
        const deleted = await confirmAndDelete(picked, manifest);
        if (deleted) {
          remaining.splice(result.index, 1);
        }
      } else if (deleteAction === "remove") {
        const removed = removeRecord(picked);
        if (removed) {
          p.log.success("Removed from history.");
          remaining.splice(result.index, 1);
        } else {
          p.log.warn("Could not find record in history.");
        }
      }
      continue;
    }

    // action === "select"
    const outcome = await handleRecordAction(picked, manifest);
    if (outcome === RecordActionOutcome.Back) {
      // Delete/remove completed (or errored) — refresh the remaining list and loop back
      const active = getActiveServers();
      const activeSet = new Set(active.map((r) => r.timestamp));
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (!activeSet.has(remaining[i].timestamp)) {
          remaining.splice(i, 1);
        }
      }
      continue;
    }
    return;
  }

  p.log.info("No servers remaining.");
}

// ── Commands ─────────────────────────────────────────────────────────────────

export async function cmdListClear(): Promise<void> {
  const records = filterHistory();
  if (records.length === 0) {
    p.log.info("No spawn history to clear.");
    return;
  }

  if (isInteractiveTTY()) {
    const shouldClear = await p.confirm({
      message: `Delete ${records.length} spawn record${records.length !== 1 ? "s" : ""} from history?`,
      initialValue: false,
    });
    if (p.isCancel(shouldClear) || !shouldClear) {
      handleCancel();
    }
  }

  const count = clearHistory();
  p.log.success(`Cleared ${count} spawn record${count !== 1 ? "s" : ""} from history.`);
}

export async function cmdList(agentFilter?: string, cloudFilter?: string): Promise<void> {
  const resolved = await resolveListFilters(agentFilter, cloudFilter);
  const manifest = resolved.manifest;
  agentFilter = resolved.agentFilter;
  cloudFilter = resolved.cloudFilter;

  if (isInteractiveTTY()) {
    // Interactive mode: show active servers with inline delete
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
      const historyRecords = filterHistory(agentFilter, cloudFilter);
      if (historyRecords.length > 0) {
        p.log.info("No active servers found. Showing spawn history:");
        renderListTable(historyRecords, manifest);
        showListFooter(historyRecords, agentFilter, cloudFilter);
      } else {
        await showEmptyListMessage(agentFilter, cloudFilter);
      }
      return;
    }

    await activeServerPicker(filtered, manifest);
    return;
  }

  // Non-interactive: show full history table
  const records = filterHistory(agentFilter, cloudFilter);
  if (records.length === 0) {
    await showEmptyListMessage(agentFilter, cloudFilter);
    return;
  }

  renderListTable(records, manifest);
  showListFooter(records, agentFilter, cloudFilter);
}

export async function cmdLast(): Promise<void> {
  const records = filterHistory();

  if (records.length === 0) {
    p.log.info("No spawn history found.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create your first spawn.`);
    return;
  }

  const latest = records[0];
  const lastManifestResult = await asyncTryCatch(() => loadManifest());
  const manifest: Manifest | null = lastManifestResult.ok ? lastManifestResult.data : null;

  const label = buildRecordLabel(latest);
  const subtitle = buildRecordSubtitle(latest, manifest);
  p.log.step(`Last spawn: ${pc.bold(label)} ${pc.dim(`(${subtitle})`)}`);

  // If the latest record has connection info (IP/server), let the user
  // reconnect to the existing VM instead of blindly provisioning a new one.
  // handleRecordAction already offers enter/reconnect/rerun/delete options
  // and falls back to cmdRun when there's no connection.
  await handleRecordAction(latest, manifest);
}
