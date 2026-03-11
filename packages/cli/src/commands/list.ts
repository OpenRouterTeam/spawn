import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import * as p from "@clack/prompts";
import pc from "picocolors";
import { clearHistory, filterHistory, getActiveServers, removeRecord } from "../history.js";
import { agentKeys, cloudKeys, loadManifest } from "../manifest.js";
import { asyncTryCatch, tryCatch, unwrapOr } from "../shared/result.js";
import { cmdConnect, cmdEnterAgent } from "./connect.js";
import { confirmAndDelete } from "./delete.js";
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
export function buildRecordLabel(r: SpawnRecord, _manifest: Manifest | null): string {
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

// ── Record actions ───────────────────────────────────────────────────────────

/** Outcome of handleRecordAction — determines whether the picker loops or exits. */
export const RecordActionOutcome = {
  /** Navigate back to the server list (delete/remove/cancel). */
  Back: 0,
  /** Exit the picker (enter/reconnect/rerun). */
  Exit: 1,
} as const;

export type RecordActionOutcome = (typeof RecordActionOutcome)[keyof typeof RecordActionOutcome];

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
    p.log.step(`Spawning ${pc.bold(buildRecordLabel(selected, manifest))}`);
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

  if (action === "enter") {
    const enterResult = await asyncTryCatch(() => cmdEnterAgent(selected.connection, selected.agent, manifest));
    if (!enterResult.ok) {
      p.log.error(`Connection failed: ${getErrorMessage(enterResult.error)}`);

      p.log.info(
        `VM may no longer be running. Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`,
      );
    }
    return RecordActionOutcome.Exit;
  }

  if (action === "reconnect") {
    const reconnectResult = await asyncTryCatch(() => cmdConnect(selected.connection));
    if (!reconnectResult.ok) {
      p.log.error(`Connection failed: ${getErrorMessage(reconnectResult.error)}`);

      p.log.info(
        `VM may no longer be running. Use ${pc.cyan(`spawn ${selected.agent} ${selected.cloud}`)} to start a new one.`,
      );
    }
    return RecordActionOutcome.Exit;
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
    `Spawning ${pc.bold(buildRecordLabel(selected, manifest))} ${pc.dim(`(${buildRecordSubtitle(selected, manifest)})`)}`,
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
      label: buildRecordLabel(r, manifest),
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

  const label = buildRecordLabel(latest, manifest);
  const subtitle = buildRecordSubtitle(latest, manifest);
  p.log.step(`Last spawn: ${pc.bold(label)} ${pc.dim(`(${subtitle})`)}`);

  // If the latest record has connection info (IP/server), let the user
  // reconnect to the existing VM instead of blindly provisioning a new one.
  // handleRecordAction already offers enter/reconnect/rerun/delete options
  // and falls back to cmdRun when there's no connection.
  await handleRecordAction(latest, manifest);
}
