import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve, isAbsolute } from "path";
import { homedir } from "os";

export interface SpawnRecord {
  agent: string;
  cloud: string;
  timestamp: string;
  prompt?: string;
}

/** Returns the directory for spawn data, respecting SPAWN_HOME env var.
 *  SPAWN_HOME must be an absolute path if set; relative paths are rejected
 *  to prevent unintended file writes. */
export function getSpawnDir(): string {
  const spawnHome = process.env.SPAWN_HOME;
  if (!spawnHome) return join(homedir(), ".spawn");
  // Require absolute path to prevent path traversal via relative paths
  if (!isAbsolute(spawnHome)) {
    throw new Error(
      `SPAWN_HOME must be an absolute path (got "${spawnHome}").\n` +
      `Example: export SPAWN_HOME=/home/user/.spawn`
    );
  }
  // Resolve to canonical form (collapses .. segments)
  return resolve(spawnHome);
}

export function getHistoryPath(): string {
  return join(getSpawnDir(), "history.json");
}

export function loadHistory(): SpawnRecord[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const MAX_HISTORY_ENTRIES = 100;

export function saveSpawnRecord(record: SpawnRecord): void {
  const dir = getSpawnDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  let history = loadHistory();
  history.push(record);
  // Trim to most recent entries to prevent unbounded growth
  if (history.length > MAX_HISTORY_ENTRIES) {
    history = history.slice(history.length - MAX_HISTORY_ENTRIES);
  }
  writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2) + "\n");
}

export function clearHistory(): number {
  const path = getHistoryPath();
  if (!existsSync(path)) return 0;
  const records = loadHistory();
  const count = records.length;
  if (count > 0) {
    unlinkSync(path);
  }
  return count;
}

export function filterHistory(
  agentFilter?: string,
  cloudFilter?: string
): SpawnRecord[] {
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
