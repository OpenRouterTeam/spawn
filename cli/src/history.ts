import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SpawnRecord {
  agent: string;
  cloud: string;
  timestamp: string;
  prompt?: string;
}

/** Returns the directory for spawn data, respecting SPAWN_HOME env var */
export function getSpawnDir(): string {
  return process.env.SPAWN_HOME || join(homedir(), ".spawn");
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

export function saveSpawnRecord(record: SpawnRecord): void {
  const dir = getSpawnDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const history = loadHistory();
  history.push(record);
  writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2) + "\n");
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
  return records;
}
