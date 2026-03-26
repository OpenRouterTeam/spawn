import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getErrorMessage } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { getHistoryPath, getSpawnDir } from "./shared/paths.js";
import { isFileError, tryCatch, tryCatchIf } from "./shared/result.js";
import { logDebug, logWarn } from "./shared/ui.js";

export interface VMConnection {
  ip: string;
  user: string;
  server_id?: string;
  server_name?: string;
  cloud?: string;
  deleted?: boolean;
  deleted_at?: string;
  launch_cmd?: string;
  metadata?: Record<string, string>;
}

export interface SpawnRecord {
  id: string;
  agent: string;
  cloud: string;
  timestamp: string;
  name?: string;
  prompt?: string;
  connection?: VMConnection;
  parent_id?: string;
  depth?: number;
}

/** Simplified cloud instance info returned by each provider's listServers(). */
export interface CloudInstance {
  id: string;
  name: string;
  ip: string;
  status: string;
}

// ── Schema versioning ──────────────────────────────────────────────────────

export const HISTORY_SCHEMA_VERSION = 1;

const VMConnectionSchema = v.object({
  ip: v.string(),
  user: v.string(),
  server_id: v.optional(v.string()),
  server_name: v.optional(v.string()),
  cloud: v.optional(v.string()),
  deleted: v.optional(v.boolean()),
  deleted_at: v.optional(v.string()),
  launch_cmd: v.optional(v.string()),
  metadata: v.optional(v.record(v.string(), v.string())),
});

export const SpawnRecordSchema = v.object({
  id: v.optional(v.string()), // optional for backwards compat with pre-migration records on disk
  agent: v.string(),
  cloud: v.string(),
  timestamp: v.string(),
  name: v.optional(v.string()),
  prompt: v.optional(v.string()),
  connection: v.optional(VMConnectionSchema),
  parent_id: v.optional(v.string()),
  depth: v.optional(v.number()),
});

/** v1 history file format: { version: 1, records: SpawnRecord[] } */
const HistoryFileV1Schema = v.object({
  version: v.literal(1),
  records: v.array(SpawnRecordSchema),
});

/** Loose v1 schema — validates shape but not individual records */
const HistoryFileV1LooseSchema = v.object({
  version: v.literal(1),
  records: v.array(v.unknown()),
});

/** Generate a unique spawn ID. */
export function generateSpawnId(): string {
  return randomUUID();
}

// ── File locking ─────────────────────────────────────────────────────────
//
// Uses mkdir-based advisory lock: mkdir is atomic on all POSIX systems and
// Windows. The lock directory doubles as a signal — if it exists, another
// process holds the lock. Stale locks (older than 30s) are force-removed
// to prevent deadlocks from crashed processes.

const LOCK_TIMEOUT_MS = 5000; // Max time to wait for lock
const LOCK_STALE_MS = 30_000; // Force-remove locks older than this
const LOCK_POLL_MS = 50; // Poll interval when waiting

function getLockPath(): string {
  return `${getHistoryPath()}.lock`;
}

function acquireLock(): boolean {
  const lockPath = getLockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const mkdirResult = tryCatch(() => {
      mkdirSync(lockPath);
    });
    if (mkdirResult.ok) {
      // Write PID + timestamp for stale detection
      const pidWriteResult = tryCatch(() => writeFileSync(join(lockPath, "pid"), `${process.pid}\n${Date.now()}`));
      if (!pidWriteResult.ok) {
        // PID write failed — clean up and retry so we don't leave an undetectable lock
        tryCatch(() => rmdirSync(lockPath));
        continue;
      }
      return true;
    }

    // Lock exists — check if stale
    const staleResult = tryCatch(() => {
      const pidFile = join(lockPath, "pid");
      if (existsSync(pidFile)) {
        const content = readFileSync(pidFile, "utf-8");
        const lines = content.split("\n");
        const lockTime = Number(lines[1]);
        if (lockTime && Date.now() - lockTime > LOCK_STALE_MS) {
          // Stale lock — force remove
          tryCatch(() => unlinkSync(join(lockPath, "pid")));
          tryCatch(() => rmdirSync(lockPath));
          return true; // Retry on next iteration
        }
      } else {
        // Lock dir exists but no PID file — broken lock, force remove
        tryCatch(() => rmdirSync(lockPath));
        return true;
      }
      return false;
    });

    if (staleResult.ok && staleResult.data) {
      continue; // Stale lock removed, retry immediately
    }

    // Wait and retry
    Bun.sleepSync(LOCK_POLL_MS);
  }

  logWarn("Could not acquire history lock — proceeding without lock");
  return false;
}

function releaseLock(): void {
  const lockPath = getLockPath();
  tryCatch(() => unlinkSync(join(lockPath, "pid")));
  tryCatch(() => rmdirSync(lockPath));
}

/** Run a function while holding the history file lock.
 *  Ensures only one process modifies history.json at a time. */
function withHistoryLock<T>(fn: () => T): T {
  const locked = acquireLock();
  const result = tryCatch(fn);
  if (locked) {
    releaseLock();
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.data;
}

/** Atomically write a JSON file: write to a process-unique .tmp, then rename into place.
 * The unique suffix prevents races when multiple concurrent spawn processes write history. */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(tmpPath, filePath);
}

/** Write history records to disk in v1 format: { version: 1, records: [...] } */
function writeHistory(records: SpawnRecord[]): void {
  atomicWriteJson(getHistoryPath(), {
    version: HISTORY_SCHEMA_VERSION,
    records,
  });
}

/** Save launch command to a history record's connection.
 *  Requires spawnId to target the correct record. */
export function saveLaunchCmd(launchCmd: string, spawnId?: string): void {
  const result = tryCatchIf(isFileError, () => {
    withHistoryLock(() => {
      const history = loadHistory();
      let found = false;

      if (spawnId) {
        const idx = history.findIndex((r) => r.id === spawnId);
        if (idx >= 0 && history[idx].connection) {
          history[idx].connection.launch_cmd = launchCmd;
          found = true;
        }
      } else {
        // Fallback: most recent record with a connection
        for (let i = history.length - 1; i >= 0; i--) {
          const conn = history[i].connection;
          if (conn) {
            conn.launch_cmd = launchCmd;
            found = true;
            break;
          }
        }
      }

      if (found) {
        writeHistory(history);
      }
    });
  });
  if (!result.ok) {
    logWarn("Could not save launch command");
    logDebug(getErrorMessage(result.error));
  }
}

/** Merge metadata key-value pairs into a history record's connection.
 *  Requires spawnId to target the correct record. */
export function saveMetadata(entries: Record<string, string>, spawnId?: string): void {
  const result = tryCatchIf(isFileError, () => {
    withHistoryLock(() => {
      const history = loadHistory();
      let found = false;

      if (spawnId) {
        const idx = history.findIndex((r) => r.id === spawnId);
        if (idx >= 0 && history[idx].connection) {
          const conn = history[idx].connection;
          conn.metadata = {
            ...conn.metadata,
            ...entries,
          };
          found = true;
        }
      } else {
        for (let i = history.length - 1; i >= 0; i--) {
          const conn = history[i].connection;
          if (conn) {
            conn.metadata = {
              ...conn.metadata,
              ...entries,
            };
            found = true;
            break;
          }
        }
      }

      if (found) {
        writeHistory(history);
      }
    });
  });
  if (!result.ok) {
    logWarn("Could not save metadata");
    logDebug(getErrorMessage(result.error));
  }
}

/** Back up a corrupted file before discarding it. Non-fatal (best-effort). */
function backupCorruptedFile(filePath: string): void {
  const result = tryCatchIf(isFileError, () => {
    copyFileSync(filePath, `${filePath}.corrupt.${Date.now()}`);
    console.error(`Warning: ${filePath} was corrupted. A backup has been saved with .corrupt suffix.`);
  });
  if (!result.ok) {
    logDebug(`Could not back up corrupted file: ${getErrorMessage(result.error)}`);
  }
}

/** Try to parse valid records from a single archive file.
 *  Uses tryCatch (catch-all) because corrupted JSON is expected — SyntaxError is not a file error. */
function parseArchiveFile(dir: string, file: string): SpawnRecord[] | null {
  const result = tryCatch(() => {
    const text = readFileSync(join(dir, file), "utf-8");
    const data: unknown = JSON.parse(text);
    if (Array.isArray(data)) {
      return data.filter((el) => v.safeParse(SpawnRecordSchema, el).success);
    }
    return [];
  });
  if (!result.ok) {
    return null;
  }
  return result.data.length > 0 ? result.data : null;
}

/** Attempt to recover records from archive files (history-*.json).
 *  Uses tryCatch (catch-all) because archive recovery is best-effort — any failure returns [].
 *  Only checks the 30 most recent archives to avoid startup slowdowns. */
function recoverFromArchives(): SpawnRecord[] {
  const result = tryCatch(() => {
    const dir = getSpawnDir();
    const files = readdirSync(dir)
      .filter((f) => /^history-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse()
      .slice(0, 30);
    for (const file of files) {
      const records = parseArchiveFile(dir, file);
      if (records) {
        console.error(`Recovered ${records.length} record(s) from archive ${file}.`);
        return records;
      }
    }
    return [];
  });
  return result.ok ? result.data : [];
}

/** Backfill missing `id` field on parsed records (pre-migration records lack it). */
function backfillRecordIds(records: v.InferOutput<typeof SpawnRecordSchema>[]): SpawnRecord[] {
  return records.map((r) => ({
    ...r,
    id: r.id ?? generateSpawnId(),
  }));
}

/** Parse raw JSON into SpawnRecord[], handling all format versions. */
function parseHistoryData(raw: unknown): SpawnRecord[] | null {
  // v1 format: { version: 1, records: [...] } — strict check
  const v1 = v.safeParse(HistoryFileV1Schema, raw);
  if (v1.success) {
    return backfillRecordIds(v1.output.records);
  }

  // Loose v1: version=1 but some individual records are malformed
  const v1Loose = v.safeParse(HistoryFileV1LooseSchema, raw);
  if (v1Loose.success) {
    const allRecords = v1Loose.output.records;
    const valid: v.InferOutput<typeof SpawnRecordSchema>[] = [];
    for (const el of allRecords) {
      const result = v.safeParse(SpawnRecordSchema, el);
      if (result.success) {
        valid.push(result.output);
      }
    }
    const dropped = allRecords.length - valid.length;
    if (dropped > 0) {
      console.error(`Warning: Dropped ${dropped} malformed record(s) from history.`);
    }
    return backfillRecordIds(valid);
  }

  // v0 format: bare array (pre-versioning; migrated to v1 on next write)
  if (Array.isArray(raw)) {
    const valid: v.InferOutput<typeof SpawnRecordSchema>[] = [];
    for (const el of raw) {
      const result = v.safeParse(SpawnRecordSchema, el);
      if (result.success) {
        valid.push(result.output);
      }
    }
    return backfillRecordIds(valid);
  }

  // Unrecognized format
  return null;
}

export function loadHistory(): SpawnRecord[] {
  const path = getHistoryPath();
  if (!existsSync(path)) {
    return [];
  }
  const readResult = tryCatchIf(isFileError, () => readFileSync(path, "utf-8"));
  if (!readResult.ok) {
    logWarn("Could not read spawn history");
    logDebug(getErrorMessage(readResult.error));
    return [];
  }
  const text = readResult.data;
  if (!text.trim()) {
    return [];
  }

  const parseResult = tryCatch((): unknown => JSON.parse(text));
  if (!parseResult.ok) {
    // JSON parse failed — file is corrupted
    backupCorruptedFile(path);
    return recoverFromArchives();
  }

  const records = parseHistoryData(parseResult.data);
  if (records !== null) {
    // Backfill IDs on legacy records that don't have one
    for (const r of records) {
      if (!r.id) {
        r.id = generateSpawnId();
      }
    }
    return records;
  }

  // Unrecognized format
  backupCorruptedFile(path);
  return recoverFromArchives();
}

export function saveSpawnRecord(record: SpawnRecord): void {
  const dir = getSpawnDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, {
      recursive: true,
      mode: 0o700,
    });
  }
  // Every record must have an id
  if (!record.id) {
    record.id = generateSpawnId();
  }

  withHistoryLock(() => {
    const history = loadHistory();
    history.push(record);
    writeHistory(history);
  });
}

export function clearHistory(): number {
  const path = getHistoryPath();
  if (!existsSync(path)) {
    return 0;
  }
  const records = loadHistory();
  const count = records.length;
  if (count > 0) {
    unlinkSync(path);
  }
  return count;
}

/** Find a record's index by id, falling back to timestamp+agent+cloud for old records. */
function findRecordIndex(history: SpawnRecord[], record: SpawnRecord): number {
  if (record.id) {
    const idx = history.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      return idx;
    }
  }
  // Fallback for records without id (pre-migration)
  return history.findIndex(
    (r) => r.timestamp === record.timestamp && r.agent === record.agent && r.cloud === record.cloud,
  );
}

/** Remove a record from history entirely (soft delete — no cloud API call). */
export function removeRecord(record: SpawnRecord): boolean {
  return withHistoryLock(() => {
    const history = loadHistory();
    const index = findRecordIndex(history, record);
    if (index < 0) {
      return false;
    }
    history.splice(index, 1);
    writeHistory(history);
    return true;
  });
}

export function markRecordDeleted(record: SpawnRecord): boolean {
  return withHistoryLock(() => {
    const history = loadHistory();
    const index = findRecordIndex(history, record);
    if (index < 0) {
      return false;
    }
    const found = history[index];
    if (!found.connection) {
      return false;
    }
    found.connection.deleted = true;
    found.connection.deleted_at = new Date().toISOString();
    writeHistory(history);
    return true;
  });
}

/** Update the IP address on a history record's connection. Returns true if the record was found and updated. */
export function updateRecordIp(record: SpawnRecord, newIp: string): boolean {
  return withHistoryLock(() => {
    const history = loadHistory();
    const index = findRecordIndex(history, record);
    if (index < 0) {
      return false;
    }
    const found = history[index];
    if (!found.connection) {
      return false;
    }
    found.connection.ip = newIp;
    writeHistory(history);
    return true;
  });
}

/** Update connection fields (ip, server_id, server_name) on a history record. Used for remapping to a different instance. */
export function updateRecordConnection(
  record: SpawnRecord,
  updates: {
    ip?: string;
    server_id?: string;
    server_name?: string;
  },
): boolean {
  return withHistoryLock(() => {
    const history = loadHistory();
    const index = findRecordIndex(history, record);
    if (index < 0) {
      return false;
    }
    const found = history[index];
    if (!found.connection) {
      return false;
    }
    if (updates.ip !== undefined) {
      found.connection.ip = updates.ip;
    }
    if (updates.server_id !== undefined) {
      found.connection.server_id = updates.server_id;
    }
    if (updates.server_name !== undefined) {
      found.connection.server_name = updates.server_name;
    }
    writeHistory(history);
    return true;
  });
}

export function getActiveServers(): SpawnRecord[] {
  const records = loadHistory();
  return records.filter((r) => r.connection?.cloud && r.connection.cloud !== "local" && !r.connection.deleted);
}

/** Merge child spawn records into local history.
 *  Sets parent_id on each child record and deduplicates by spawn ID. */
export function mergeChildHistory(parentSpawnId: string, childRecords: SpawnRecord[]): void {
  if (childRecords.length === 0) {
    return;
  }

  withHistoryLock(() => {
    const history = loadHistory();
    const existingIds = new Set(history.map((r) => r.id));

    for (const child of childRecords) {
      if (!child.id) {
        child.id = generateSpawnId();
      }
      // Skip duplicates
      if (existingIds.has(child.id)) {
        continue;
      }
      // Ensure parent_id is set
      if (!child.parent_id) {
        child.parent_id = parentSpawnId;
      }
      history.push(child);
      existingIds.add(child.id);
    }

    writeHistory(history);
  });
}

/** Export history records as JSON string (for `spawn history export`). */
export function exportHistory(): string {
  const records = loadHistory();
  return JSON.stringify(records, null, 2);
}

export function filterHistory(agentFilter?: string, cloudFilter?: string): SpawnRecord[] {
  let records = loadHistory();
  if (agentFilter) {
    const lower = agentFilter.toLowerCase();
    records = records.filter((r) => r.agent.toLowerCase() === lower);
  }
  if (cloudFilter) {
    const lower = cloudFilter.toLowerCase();
    records = records.filter((r) => r.cloud.toLowerCase() === lower);
  }
  // Show newest first (reverse chronological order)
  records.reverse();

  return records;
}
