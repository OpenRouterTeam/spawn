// commands/pull-history.ts — `spawn pull-history`: recursively pull child spawn history
// Called automatically by the parent after a session ends, or manually.
// SSHes into each active child, tells it to pull from ITS children first,
// then downloads its history.json and merges into local history.

import type { SpawnRecord } from "../history.js";

import * as v from "valibot";
import { getActiveServers, mergeChildHistory, SpawnRecordSchema } from "../history.js";
import { validateConnectionIP, validateUsername } from "../security.js";
import { parseJsonWith } from "../shared/parse.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { logDebug, logInfo } from "../shared/ui.js";

const ChildHistorySchema = v.object({
  version: v.optional(v.number()),
  records: v.array(SpawnRecordSchema),
});

/**
 * Parse a child's history.json content and merge valid records into local history.
 * Exported for testing — the SSH transport is in cmdPullHistory/pullFromChild.
 */
export function parseAndMergeChildHistory(json: string, parentSpawnId: string): number {
  if (!json.trim() || json.trim() === "{}") {
    return 0;
  }

  const parsed = parseJsonWith(json, ChildHistorySchema);
  if (!parsed || parsed.records.length === 0) {
    return 0;
  }

  const validRecords: SpawnRecord[] = [];
  for (const r of parsed.records) {
    if (r.id) {
      validRecords.push({
        id: r.id,
        agent: r.agent,
        cloud: r.cloud,
        timestamp: r.timestamp,
        ...(r.name
          ? {
              name: r.name,
            }
          : {}),
        ...(r.parent_id
          ? {
              parent_id: r.parent_id,
            }
          : {}),
        ...(r.depth !== undefined
          ? {
              depth: r.depth,
            }
          : {}),
        ...(r.connection
          ? {
              connection: r.connection,
            }
          : {}),
      });
    }
  }

  if (validRecords.length > 0) {
    mergeChildHistory(parentSpawnId, validRecords);
  }
  return validRecords.length;
}

/**
 * Pull history from all active child VMs recursively.
 * For each active child:
 *   1. SSH in, run `spawn pull-history` (recurse into grandchildren)
 *   2. Download the child's history.json
 *   3. Merge into local history with parent_id links
 */
export async function cmdPullHistory(): Promise<void> {
  const active = getActiveServers();

  if (active.length === 0) {
    return;
  }

  const keysResult = await asyncTryCatch(() => ensureSshKeys());
  if (!keysResult.ok) {
    logDebug("Could not load SSH keys for history pull");
    return;
  }
  const sshKeyOpts = getSshKeyOpts(keysResult.data);

  for (const record of active) {
    if (!record.connection?.ip || !record.connection?.user) {
      continue;
    }

    const { ip, user } = record.connection;
    const spawnId = record.id;

    const validation = tryCatch(() => {
      validateUsername(user);
      validateConnectionIP(ip);
    });
    if (!validation.ok) {
      logDebug(`Skipping record with invalid connection: ${user}@${ip}`);
      continue;
    }

    await pullFromChild(ip, user, spawnId, sshKeyOpts);
  }
}

async function pullFromChild(ip: string, user: string, parentSpawnId: string, sshKeyOpts: string[]): Promise<void> {
  const result = await asyncTryCatch(async () => {
    const sshBase = [
      "ssh",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      ...sshKeyOpts,
      `${user}@${ip}`,
    ];

    // Step 1: Tell the child to recursively pull from its own children
    const recurseProc = Bun.spawnSync(
      [
        ...sshBase,
        'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; spawn pull-history 2>/dev/null || true',
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
        timeout: 60_000,
      },
    );
    if (recurseProc.exitCode !== 0) {
      logDebug(`Recursive pull on ${ip} returned ${recurseProc.exitCode} (may not support pull-history)`);
    }

    // Step 2: Download the child's history.json via SSH + cat
    const catProc = Bun.spawnSync(
      [
        ...sshBase,
        "cat ~/.spawn/history.json 2>/dev/null || cat ~/.config/spawn/history.json 2>/dev/null || echo '{}'",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
        timeout: 30_000,
      },
    );

    if (catProc.exitCode !== 0) {
      return;
    }

    const json = new TextDecoder().decode(catProc.stdout);
    const merged = parseAndMergeChildHistory(json, parentSpawnId);
    if (merged > 0) {
      logInfo(`Pulled ${merged} record(s) from ${ip}`);
    }
  });

  if (!result.ok) {
    logDebug(`Could not pull history from ${ip}`);
  }
}
