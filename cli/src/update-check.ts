import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import pc from "picocolors";
import { VERSION } from "./version.js";
import { RAW_BASE, CACHE_DIR } from "./manifest.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const CHECK_INTERVAL = 86400; // 24 hours in seconds
const FETCH_TIMEOUT = 5000; // 5 seconds (shorter timeout for background check)

// Allow tests to override the cache directory
function getUpdateCheckFile(): string {
  const cacheDir = process.env.TEST_CACHE_DIR || CACHE_DIR;
  return join(cacheDir, "update-check.json");
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface UpdateCheckCache {
  lastCheck: number;
  latestVersion?: string;
  dismissed?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readUpdateCache(): UpdateCheckCache | null {
  try {
    const updateCheckFile = getUpdateCheckFile();
    if (!existsSync(updateCheckFile)) return null;
    return JSON.parse(readFileSync(updateCheckFile, "utf-8")) as UpdateCheckCache;
  } catch {
    return null;
  }
}

function writeUpdateCache(data: UpdateCheckCache): void {
  try {
    const cacheDir = process.env.TEST_CACHE_DIR || CACHE_DIR;
    const updateCheckFile = getUpdateCheckFile();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(updateCheckFile, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Silently fail - update check is non-critical
  }
}

function shouldCheckForUpdate(): boolean {
  const cache = readUpdateCache();
  if (!cache) return true;

  const now = Math.floor(Date.now() / 1000);
  const timeSinceLastCheck = now - cache.lastCheck;

  return timeSinceLastCheck >= CHECK_INTERVAL;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${RAW_BASE}/cli/package.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;

    const pkg = (await res.json()) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

function compareVersions(current: string, latest: string): boolean {
  // Simple semantic version comparison (assumes format: major.minor.patch)
  const parseSemver = (v: string): number[] =>
    v.split(".").map((n) => parseInt(n, 10) || 0);

  const currentParts = parseSemver(current);
  const latestParts = parseSemver(latest);

  for (let i = 0; i < 3; i++) {
    if ((latestParts[i] || 0) > (currentParts[i] || 0)) return true;
    if ((latestParts[i] || 0) < (currentParts[i] || 0)) return false;
  }

  return false; // Versions are equal
}

function printUpdateNotification(latestVersion: string): void {
  console.error(); // Use stderr so it doesn't interfere with parseable output
  console.error(pc.yellow("┌────────────────────────────────────────────────────────────┐"));
  console.error(
    pc.yellow("│ ") +
    pc.bold(`Update available: v${VERSION} → `) +
    pc.green(pc.bold(`v${latestVersion}`)) +
    pc.yellow("                       │")
  );
  console.error(
    pc.yellow("│ Run: ") +
    pc.cyan(pc.bold("spawn update")) +
    pc.yellow(" to see how to upgrade              │")
  );
  console.error(pc.yellow("└────────────────────────────────────────────────────────────┘"));
  console.error();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Check for updates in the background (non-blocking).
 * Shows a notification if a newer version is available.
 * Only checks once per day to avoid network overhead.
 */
export async function checkForUpdates(): Promise<void> {
  // Skip in test environment
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return;
  }

  // Skip if SPAWN_NO_UPDATE_CHECK is set
  if (process.env.SPAWN_NO_UPDATE_CHECK === "1") {
    return;
  }

  // Skip if we checked recently
  if (!shouldCheckForUpdate()) {
    // Show cached notification if available
    const cache = readUpdateCache();
    if (cache?.latestVersion && compareVersions(VERSION, cache.latestVersion)) {
      printUpdateNotification(cache.latestVersion);
    }
    return;
  }

  // Fetch latest version (non-blocking, don't await)
  fetchLatestVersion()
    .then((latestVersion) => {
      if (!latestVersion) return;

      const now = Math.floor(Date.now() / 1000);

      // Update cache with latest check time
      writeUpdateCache({
        lastCheck: now,
        latestVersion,
      });

      // Show notification if newer version is available
      if (compareVersions(VERSION, latestVersion)) {
        printUpdateNotification(latestVersion);
      }
    })
    .catch(() => {
      // Silently fail - update check is non-critical
    });
}
