import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { validateConnectionIP, validateUsername, validateServerIdentifier } from "./security.js";
import { isString } from "@openrouter/spawn-shared";

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
  agent: string;
  cloud: string;
  timestamp: string;
  name?: string;
  prompt?: string;
  connection?: VMConnection;
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

export function getConnectionPath(): string {
  return join(getSpawnDir(), "last-connection.json");
}

/** Save VM connection info to last-connection.json for later reconnection/deletion. */
export function saveVmConnection(
  ip: string,
  user: string,
  serverId: string,
  serverName: string,
  cloud: string,
  launchCmd?: string,
  metadata?: Record<string, string>,
): void {
  const dir = getSpawnDir();
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });
  const json: Record<string, unknown> = {
    ip,
    user,
  };
  if (serverId) {
    json.server_id = serverId;
  }
  if (serverName) {
    json.server_name = serverName;
  }
  if (cloud) {
    json.cloud = cloud;
  }
  if (launchCmd) {
    json.launch_cmd = launchCmd;
  }
  if (metadata && Object.keys(metadata).length > 0) {
    json.metadata = metadata;
  }
  writeFileSync(join(dir, "last-connection.json"), JSON.stringify(json) + "\n", { mode: 0o600 });
}

/** Save launch command to the last-connection.json file. */
export function saveLaunchCmd(launchCmd: string): void {
  const connFile = getConnectionPath();
  try {
    const data = JSON.parse(readFileSync(connFile, "utf-8"));
    data.launch_cmd = launchCmd;
    writeFileSync(connFile, JSON.stringify(data) + "\n", { mode: 0o600 });
  } catch {
    // non-fatal
  }
}

export function loadHistory(): SpawnRecord[] {
  const path = getHistoryPath();
  if (!existsSync(path)) {
    return [];
  }
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
    mkdirSync(dir, {
      recursive: true,
      mode: 0o700,
    });
  }
  let history = loadHistory();
  history.push(record);
  // Trim to most recent entries to prevent unbounded growth
  if (history.length > MAX_HISTORY_ENTRIES) {
    history = history.slice(history.length - MAX_HISTORY_ENTRIES);
  }
  writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
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

/** Check for pending connection data and merge it into the last history entry.
 *  Bash scripts write connection info to last-connection.json after successful spawn.
 *  This function merges that data into the history and persists it. */
export function mergeLastConnection(): void {
  const connPath = getConnectionPath();
  if (!existsSync(connPath)) {
    return;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(connPath, "utf-8"));
    if (!raw || typeof raw !== "object" || !("ip" in raw) || !("user" in raw)) {
      unlinkSync(connPath);
      return;
    }
    const entries = Object.fromEntries(Object.entries(raw));
    // Parse metadata if present
    let metadata: Record<string, string> | undefined;
    if (entries.metadata && typeof entries.metadata === "object" && !Array.isArray(entries.metadata)) {
      metadata = {};
      for (const [k, v] of Object.entries(entries.metadata)) {
        if (isString(v)) {
          metadata[k] = v;
        }
      }
      if (Object.keys(metadata).length === 0) {
        metadata = undefined;
      }
    }

    const connData: VMConnection = {
      ip: String(entries.ip ?? ""),
      user: String(entries.user ?? ""),
      server_id: isString(entries.server_id) ? entries.server_id : undefined,
      server_name: isString(entries.server_name) ? entries.server_name : undefined,
      cloud: isString(entries.cloud) ? entries.cloud : undefined,
      launch_cmd: isString(entries.launch_cmd) ? entries.launch_cmd : undefined,
      metadata,
    };

    // SECURITY: Validate connection data before merging into history
    // This prevents malicious bash scripts from injecting invalid data
    try {
      validateConnectionIP(connData.ip);
      validateUsername(connData.user);
      if (connData.server_id) {
        validateServerIdentifier(connData.server_id);
      }
      if (connData.server_name) {
        validateServerIdentifier(connData.server_name);
      }
    } catch (err) {
      // Log validation failure and skip merging
      // Use duck typing instead of instanceof to avoid prototype chain issues
      console.error(
        `Warning: Invalid connection data from bash script, skipping merge: ${err && typeof err === "object" && "message" in err ? String(err.message) : String(err)}`,
      );
      unlinkSync(connPath);
      return;
    }

    const history = loadHistory();

    if (history.length > 0) {
      // Update the most recent entry with connection info
      const latest = history[history.length - 1];
      if (!latest.connection) {
        latest.connection = connData;
        // Save updated history
        writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
      }
    }

    // Clean up the connection file after merging
    unlinkSync(connPath);
  } catch {
    // Ignore errors - connection data is optional
  }
}

/** Remove a record from history entirely (soft delete — no cloud API call). */
export function removeRecord(record: SpawnRecord): boolean {
  const history = loadHistory();
  const index = history.findIndex(
    (r) => r.timestamp === record.timestamp && r.agent === record.agent && r.cloud === record.cloud,
  );
  if (index < 0) {
    return false;
  }
  history.splice(index, 1);
  writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export function markRecordDeleted(record: SpawnRecord): boolean {
  const history = loadHistory();
  const index = history.findIndex(
    (r) => r.timestamp === record.timestamp && r.agent === record.agent && r.cloud === record.cloud,
  );
  if (index < 0) {
    return false;
  }
  const found = history[index];
  if (!found.connection) {
    return false;
  }
  found.connection.deleted = true;
  found.connection.deleted_at = new Date().toISOString();
  writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export function getActiveServers(): SpawnRecord[] {
  mergeLastConnection();
  const records = loadHistory();
  return records.filter((r) => r.connection?.cloud && r.connection.cloud !== "local" && !r.connection.deleted);
}

export function filterHistory(agentFilter?: string, cloudFilter?: string): SpawnRecord[] {
  // Merge any pending connection data before filtering
  mergeLastConnection();

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
