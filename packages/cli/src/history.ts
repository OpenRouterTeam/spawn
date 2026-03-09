import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as v from "valibot";
import { tryCatch } from "./shared/result.js";

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

const SpawnRecordSchema = v.object({
  id: v.optional(v.string()),
  agent: v.string(),
  cloud: v.string(),
  timestamp: v.string(),
  name: v.optional(v.string()),
  prompt: v.optional(v.string()),
  connection: v.optional(VMConnectionSchema),
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

/** Returns the directory for spawn data, respecting SPAWN_HOME env var.
 *  SPAWN_HOME must be an absolute path if set; relative paths are rejected
 *  to prevent unintended file writes. */
export function getSpawnDir(): string {
  const spawnHome = process.env.SPAWN_HOME;
  if (!spawnHome) {
    return join(homedir(), ".spawn");
  }
  // Require absolute path to prevent path traversal via relative paths
  if (!isAbsolute(spawnHome)) {
    throw new Error(
      `SPAWN_HOME must be an absolute path (got "${spawnHome}").\n` + "Example: export SPAWN_HOME=/home/user/.spawn",
    );
  }
  // Resolve to canonical form (collapses .. segments)
  const resolved = resolve(spawnHome);

  // SECURITY: Prevent path traversal to system directories
  // Even though the path is absolute, resolve() can normalize paths like
  // /tmp/../../root/.spawn to /root/.spawn, potentially allowing unauthorized
  // file writes to sensitive directories.
  const userHome = homedir();
  if (!resolved.startsWith(userHome + "/") && resolved !== userHome) {
    throw new Error("SPAWN_HOME must be within your home directory.\n" + `Got: ${resolved}\n` + `Home: ${userHome}`);
  }

  return resolved;
}

export function getHistoryPath(): string {
  return join(getSpawnDir(), "history.json");
}

/** Atomically write a JSON file: write to .tmp, then rename into place. */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
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
 *  Matches by spawnId when provided; falls back to most recent record with a connection. */
export function saveLaunchCmd(launchCmd: string, spawnId?: string): void {
  // non-fatal — discard errors
  tryCatch(() => {
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
}

/** Back up a corrupted file before discarding it. Non-fatal (best-effort). */
function backupCorruptedFile(filePath: string): void {
  tryCatch(() => {
    copyFileSync(filePath, `${filePath}.corrupt.${Date.now()}`);
    console.error(`Warning: ${filePath} was corrupted. A backup has been saved with .corrupt suffix.`);
  });
}

/** Try to parse valid records from a single archive file. */
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

/** Attempt to recover records from archive files (history-*.json). */
function recoverFromArchives(): SpawnRecord[] {
  const result = tryCatch(() => {
    const dir = getSpawnDir();
    const files = readdirSync(dir)
      .filter((f) => /^history-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
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

/** Parse raw JSON into SpawnRecord[], handling all format versions. */
function parseHistoryData(raw: unknown): SpawnRecord[] | null {
  // v1 format: { version: 1, records: [...] } — strict check
  const v1 = v.safeParse(HistoryFileV1Schema, raw);
  if (v1.success) {
    return v1.output.records;
  }

  // Loose v1: version=1 but some individual records are malformed
  const v1Loose = v.safeParse(HistoryFileV1LooseSchema, raw);
  if (v1Loose.success) {
    const allRecords = v1Loose.output.records;
    const valid = allRecords.filter((el) => v.safeParse(SpawnRecordSchema, el).success);
    const dropped = allRecords.length - valid.length;
    if (dropped > 0) {
      console.error(`Warning: Dropped ${dropped} malformed record(s) from history.`);
    }
    return valid;
  }

  // v0 format: bare array (pre-versioning; migrated to v1 on next write)
  if (Array.isArray(raw)) {
    return raw.filter((el) => v.safeParse(SpawnRecordSchema, el).success);
  }

  // Unrecognized format
  return null;
}

export function loadHistory(): SpawnRecord[] {
  const path = getHistoryPath();
  if (!existsSync(path)) {
    return [];
  }
  const readResult = tryCatch(() => readFileSync(path, "utf-8"));
  if (!readResult.ok) {
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
    return records;
  }

  // Unrecognized format
  backupCorruptedFile(path);
  return recoverFromArchives();
}

const MAX_HISTORY_ENTRIES = 100;

/** Read existing records from an archive file, returning [] if missing or corrupted. */
function readExistingArchive(archivePath: string): SpawnRecord[] {
  if (!existsSync(archivePath)) {
    return [];
  }
  const result = tryCatch((): unknown => JSON.parse(readFileSync(archivePath, "utf-8")));
  if (result.ok && Array.isArray(result.data)) {
    return result.data;
  }
  // Corrupted archive — overwrite
  return [];
}

/** Archive evicted records to a dated backup file so nothing is permanently lost. */
function archiveRecords(records: SpawnRecord[]): void {
  if (records.length === 0) {
    return;
  }
  // Non-fatal — archive failure should not block saving
  tryCatch(() => {
    const dir = getSpawnDir();
    const date = new Date().toISOString().slice(0, 10);
    const archivePath = join(dir, `history-${date}.json`);
    const existing = readExistingArchive(archivePath);
    const merged = [
      ...existing,
      ...records,
    ];
    atomicWriteJson(archivePath, merged);
  });
}

export function saveSpawnRecord(record: SpawnRecord): void {
  const dir = getSpawnDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, {
      recursive: true,
      mode: 0o700,
    });
  }
  // Ensure every record has an id
  if (!record.id) {
    record.id = generateSpawnId();
  }
  let history = loadHistory();
  history.push(record);
  // Smart trim: evict deleted records first, then oldest, and archive evicted
  if (history.length > MAX_HISTORY_ENTRIES) {
    const nonDeleted: SpawnRecord[] = [];
    const deleted: SpawnRecord[] = [];
    for (const r of history) {
      if (r.connection?.deleted) {
        deleted.push(r);
      } else {
        nonDeleted.push(r);
      }
    }
    if (nonDeleted.length <= MAX_HISTORY_ENTRIES) {
      // Removing deleted records is enough
      history = nonDeleted;
      archiveRecords(deleted);
    } else {
      // Still over limit — trim oldest non-deleted records too
      const overflow = nonDeleted.slice(0, nonDeleted.length - MAX_HISTORY_ENTRIES);
      history = nonDeleted.slice(nonDeleted.length - MAX_HISTORY_ENTRIES);
      archiveRecords([
        ...deleted,
        ...overflow,
      ]);
    }
  }
  writeHistory(history);
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
  const history = loadHistory();
  const index = findRecordIndex(history, record);
  if (index < 0) {
    return false;
  }
  history.splice(index, 1);
  writeHistory(history);
  return true;
}

export function markRecordDeleted(record: SpawnRecord): boolean {
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
}

export function getActiveServers(): SpawnRecord[] {
  const records = loadHistory();
  return records.filter((r) => r.connection?.cloud && r.connection.cloud !== "local" && !r.connection.deleted);
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
