import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { execSync as nodeExecSync } from "child_process";
import pc from "picocolors";
import { VERSION } from "./version.js";
import { RAW_BASE, CACHE_DIR } from "./manifest.js";

// Internal executor for testability - can be replaced in tests
export const executor = {
  execSync: (cmd: string, options?: any) => nodeExecSync(cmd, options),
};

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

function performAutoUpdate(latestVersion: string): void {
  console.error(); // Use stderr so it doesn't interfere with parseable output
  console.error(pc.yellow("┌────────────────────────────────────────────────────────────┐"));
  console.error(
    pc.yellow("│ ") +
    pc.bold(`Update available: v${VERSION} → `) +
    pc.green(pc.bold(`v${latestVersion}`)) +
    pc.yellow("                       │")
  );
  console.error(
    pc.yellow("│ ") +
    pc.bold("Updating automatically...") +
    pc.yellow("                                  │")
  );
  console.error(pc.yellow("└────────────────────────────────────────────────────────────┘"));
  console.error();

  try {
    // Run the install script to update
    executor.execSync(`curl -fsSL ${RAW_BASE}/cli/install.sh | bash`, {
      stdio: "inherit",
      shell: "/bin/bash",
    });

    console.error();
    console.error(pc.green(pc.bold("✓ Updated successfully!")));
    console.error(pc.dim("  Restart your command to use the new version."));
    console.error();

    // Exit cleanly after update
    process.exit(0);
  } catch (err) {
    console.error();
    console.error(pc.red(pc.bold("✗ Auto-update failed")));
    console.error(pc.dim("  Please update manually:"));
    console.error();
    console.error(pc.cyan(`  curl -fsSL ${RAW_BASE}/cli/install.sh | bash`));
    console.error();
    // Continue with original command despite update failure
  }
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
    // Auto-update if cached version is newer
    const cache = readUpdateCache();
    if (cache?.latestVersion && compareVersions(VERSION, cache.latestVersion)) {
      performAutoUpdate(cache.latestVersion);
    }
    return;
  }

  // Fetch latest version (blocking for auto-update)
  try {
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) return;

    const now = Math.floor(Date.now() / 1000);

    // Update cache with latest check time
    writeUpdateCache({
      lastCheck: now,
      latestVersion,
    });

    // Auto-update if newer version is available
    if (compareVersions(VERSION, latestVersion)) {
      performAutoUpdate(latestVersion);
    }
  } catch {
    // Silently fail - update check is non-critical
  }
}
