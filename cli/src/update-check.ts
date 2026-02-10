import { execSync as nodeExecSync } from "child_process";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { RAW_BASE } from "./manifest.js";

const VERSION = pkg.version;

// Internal executor for testability - can be replaced in tests
export const executor = {
  execSync: (cmd: string, options?: any) => nodeExecSync(cmd, options),
};

// ── Constants ──────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 5000; // 5 seconds

// ── Helpers ────────────────────────────────────────────────────────────────────

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
 * Check for updates on every run and auto-update if available.
 * Uses a 5-second timeout to avoid blocking for too long.
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

  // Always fetch the latest version on every run
  try {
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) return;

    // Auto-update if newer version is available
    if (compareVersions(VERSION, latestVersion)) {
      performAutoUpdate(latestVersion);
    }
  } catch {
    // Silently fail - update check is non-critical
  }
}
