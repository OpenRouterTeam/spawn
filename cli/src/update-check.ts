import "./unicode-detect.js"; // Ensure TERM is set before using symbols
import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  type ExecSyncOptions,
  type ExecFileSyncOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import * as v from "valibot";
import { parseJsonWith } from "./shared/parse";
import pkg from "../package.json" with { type: "json" };
import { RAW_BASE } from "./manifest.js";
import { hasStatus } from "./shared/type-guards";

const VERSION = pkg.version;

// Internal executor for testability - can be replaced in tests
export const executor = {
  execSync: (cmd: string, options?: ExecSyncOptions) => nodeExecSync(cmd, options),
  execFileSync: (file: string, args: string[], options?: ExecFileSyncOptions) => nodeExecFileSync(file, args, options),
};

// ── Constants ──────────────────────────────────────────────────────────────────

// ── Schemas ──────────────────────────────────────────────────────────────────

const PkgVersionSchema = v.object({
  version: v.string(),
});

const FETCH_TIMEOUT = 10000; // 10 seconds
const UPDATE_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

// Validate RAW_BASE matches expected GitHub raw content URL pattern (defense-in-depth, CWE-78)
const GITHUB_RAW_URL_PATTERN =
  /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
if (!GITHUB_RAW_URL_PATTERN.test(RAW_BASE)) {
  throw new Error(`RAW_BASE URL does not match expected GitHub raw URL pattern: ${RAW_BASE}`);
}

// Use ASCII-safe symbols when unicode is disabled (SSH, dumb terminals)
const isAscii = process.env.TERM === "linux";
const CHECK_MARK = isAscii ? "*" : "\u2713";
const CROSS_MARK = isAscii ? "x" : "\u2717";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${RAW_BASE}/cli/package.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) {
      return null;
    }

    const data = parseJsonWith(await res.text(), PkgVersionSchema);
    return data?.version ?? null;
  } catch {
    return null;
  }
}

function compareVersions(current: string, latest: string): boolean {
  // Simple semantic version comparison (assumes format: major.minor.patch)
  const parseSemver = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);

  const currentParts = parseSemver(current);
  const latestParts = parseSemver(latest);

  for (let i = 0; i < 3; i++) {
    if ((latestParts[i] || 0) > (currentParts[i] || 0)) {
      return true;
    }
    if ((latestParts[i] || 0) < (currentParts[i] || 0)) {
      return false;
    }
  }

  return false;
}

// ── Failure Backoff ──────────────────────────────────────────────────────────

function getUpdateFailedPath(): string {
  return path.join(process.env.HOME || "/tmp", ".config", "spawn", ".update-failed");
}

export function isUpdateBackedOff(): boolean {
  try {
    const failedPath = getUpdateFailedPath();
    const content = fs.readFileSync(failedPath, "utf8").trim();
    const failedAt = Number.parseInt(content, 10);
    if (Number.isNaN(failedAt)) {
      return false;
    }
    return Date.now() - failedAt < UPDATE_BACKOFF_MS;
  } catch {
    return false;
  }
}

function markUpdateFailed(): void {
  try {
    const failedPath = getUpdateFailedPath();
    fs.mkdirSync(path.dirname(failedPath), {
      recursive: true,
    });
    fs.writeFileSync(failedPath, String(Date.now()));
  } catch {
    // Best-effort — don't break the CLI if we can't write the file
  }
}

function clearUpdateFailed(): void {
  try {
    fs.unlinkSync(getUpdateFailedPath());
  } catch {
    // File may not exist — that's fine
  }
}

/** Print boxed update banner to stderr */
function printUpdateBanner(latestVersion: string): void {
  const line1 = `Update available: v${VERSION} -> v${latestVersion}`;
  const line2 = "Updating automatically...";
  const width = Math.max(line1.length, line2.length) + 4;
  const border = "+" + "-".repeat(width) + "+";

  console.error(); // Use stderr so it doesn't interfere with parseable output
  console.error(pc.yellow(border));
  console.error(
    pc.yellow("| ") +
      pc.bold(`Update available: v${VERSION} -> `) +
      pc.green(pc.bold(`v${latestVersion}`)) +
      " ".repeat(width - 2 - line1.length) +
      pc.yellow(" |"),
  );
  console.error(pc.yellow("| ") + pc.bold(line2) + " ".repeat(width - 2 - line2.length) + pc.yellow(" |"));
  console.error(pc.yellow(border));
  console.error();
}

/**
 * Find the spawn binary to re-exec after an update.
 *
 * Prefers `which spawn` (PATH resolution) over process.argv[1] because the
 * installer may place the new binary in a different directory than where the
 * currently running binary lives, causing re-exec to run the stale old binary.
 */
function findUpdatedBinary(): string {
  try {
    const result = executor.execSync("which spawn 2>/dev/null", {
      encoding: "utf8",
      shell: "/bin/bash",
    });
    const found = result ? result.toString().trim() : "";
    if (found) {
      return found;
    }
  } catch {
    // fall through to argv fallback
  }
  return process.argv[1] || "spawn";
}

/** Re-exec the updated binary with the original CLI arguments, forwarding the exit code */
function reExecWithArgs(): void {
  const args = process.argv.slice(2);
  const binPath = findUpdatedBinary();

  if (args.length === 0) {
    console.error(pc.dim("  Restarting spawn with updated version..."));
  } else {
    console.error(pc.dim(`  Rerunning: spawn ${args.join(" ")}`));
  }
  console.error();

  try {
    executor.execFileSync(binPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        SPAWN_NO_UPDATE_CHECK: "1",
      },
    });
    process.exit(0);
  } catch (reexecErr) {
    const code = hasStatus(reexecErr) ? reexecErr.status : 1;
    process.exit(code);
  }
}

function performAutoUpdate(latestVersion: string): void {
  printUpdateBanner(latestVersion);

  // Validate RAW_BASE immediately before use to prevent command injection (CWE-78, #1819)
  if (!GITHUB_RAW_URL_PATTERN.test(RAW_BASE)) {
    throw new Error(`Security: RAW_BASE failed pre-execution validation: ${RAW_BASE}`);
  }

  try {
    executor.execSync(`curl -fsSL ${RAW_BASE}/sh/cli/install.sh | bash`, {
      stdio: "inherit",
      shell: "/bin/bash",
    });

    console.error();
    console.error(pc.green(pc.bold(`${CHECK_MARK} Updated successfully!`)));
    clearUpdateFailed();
    reExecWithArgs();
  } catch {
    markUpdateFailed();
    console.error();
    console.error(pc.red(pc.bold(`${CROSS_MARK} Auto-update failed`)));
    console.error(pc.dim("  Please update manually:"));
    console.error();
    console.error(pc.cyan(`  curl -fsSL ${RAW_BASE}/sh/cli/install.sh | bash`));
    console.error();
    // Continue with original command despite update failure
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Check for updates on every run and auto-update if available.
 * Uses a 10-second timeout to avoid blocking for too long.
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

  // Skip if a recent auto-update failed (backoff for 1 hour)
  if (isUpdateBackedOff()) {
    return;
  }

  // Always fetch the latest version on every run
  try {
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) {
      return;
    }

    // Auto-update if newer version is available
    if (compareVersions(VERSION, latestVersion)) {
      performAutoUpdate(latestVersion);
    }
  } catch {
    // Silently fail - update check is non-critical
  }
}
