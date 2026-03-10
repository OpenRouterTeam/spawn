// shared/paths.ts — Centralized filesystem path resolution
//
// All path helpers live here. Production code imports from this module;
// no other module should call homedir() or construct spawn-specific paths directly.

import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Return the user's home directory, preferring $HOME over os.homedir(). */
export function getUserHome(): string {
  return process.env.HOME || homedir();
}

/** Returns the directory for spawn data, respecting SPAWN_HOME env var.
 *  SPAWN_HOME must be an absolute path if set; relative paths are rejected
 *  to prevent unintended file writes. */
export function getSpawnDir(): string {
  const spawnHome = process.env.SPAWN_HOME;
  if (!spawnHome) {
    return join(getUserHome(), ".spawn");
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
  const userHome = getUserHome();
  if (!resolved.startsWith(userHome + "/") && resolved !== userHome) {
    throw new Error("SPAWN_HOME must be within your home directory.\n" + `Got: ${resolved}\n` + `Home: ${userHome}`);
  }

  return resolved;
}

/** Path to the spawn history file. */
export function getHistoryPath(): string {
  return join(getSpawnDir(), "history.json");
}

/**
 * Return the path to the per-cloud config file: ~/.config/spawn/{cloud}.json
 * Shared by all cloud modules to avoid repeating the same path construction.
 */
export function getSpawnCloudConfigPath(cloud: string): string {
  return join(getUserHome(), ".config", "spawn", `${cloud}.json`);
}

/** Return the cache directory for spawn, respecting XDG_CACHE_HOME. */
export function getCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(getUserHome(), ".cache"), "spawn");
}

/** Return the path to the cached manifest file. */
export function getCacheFile(): string {
  return join(getCacheDir(), "manifest.json");
}

/** Return the path to the update-failed sentinel file. */
export function getUpdateFailedPath(): string {
  return join(getUserHome(), ".config", "spawn", ".update-failed");
}

/** Return the path to the user's ~/.ssh directory. */
export function getSshDir(): string {
  return join(getUserHome(), ".ssh");
}

/** Return the system temp directory (wraps os.tmpdir()). */
export function getTmpDir(): string {
  return tmpdir();
}
