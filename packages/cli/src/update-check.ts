import "./unicode-detect.js"; // Ensure TERM is set before using symbols
import type { ExecFileSyncOptions } from "node:child_process";

import { execFileSync as nodeExecFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getErrorMessage, hasStatus } from "@openrouter/spawn-shared";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { RAW_BASE, SPAWN_CDN, VERSION_URL } from "./manifest.js";
import { PkgVersionSchema, parseJsonWith } from "./shared/parse.js";
import { getUpdateCheckedPath, getUpdateFailedPath } from "./shared/paths.js";
import { asyncTryCatchIf, isFileError, isNetworkError, tryCatch, tryCatchIf, unwrapOr } from "./shared/result.js";
import { getInstallCmd, getInstallScriptUrl, getWhichCommand, isWindows } from "./shared/shell.js";
import { logDebug, logWarn } from "./shared/ui.js";

const VERSION = pkg.version;

// Internal executor for testability - can be replaced in tests
export const executor = {
  execFileSync: (file: string, args: string[], options?: ExecFileSyncOptions) => nodeExecFileSync(file, args, options),
};

// ── Constants ──────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT = 10000; // 10 seconds
const MIN_INSTALL_SCRIPT_BYTES = 100; // reject suspiciously small scripts
const UPDATE_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour — skip network check if last success was recent

// Use ASCII-safe symbols when unicode is disabled (SSH, dumb terminals)
const isAscii = process.env.TERM === "linux";
const CHECK_MARK = isAscii ? "*" : "\u2713";
const CROSS_MARK = isAscii ? "x" : "\u2717";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fetchLatestVersion(): Promise<string | null> {
  // Primary: plain-text version file from GitHub release artifact (static URL)
  const primary = await asyncTryCatchIf(isNetworkError, async () => {
    const res = await fetch(VERSION_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && /^\d+\.\d+\.\d+/.test(text)) {
        return text;
      }
    }
    return null;
  });
  if (primary.ok && primary.data) {
    return primary.data;
  }

  // Fallback: package.json from GitHub raw
  const fallback = await asyncTryCatchIf(isNetworkError, async () => {
    const res = await fetch(`${RAW_BASE}/packages/cli/package.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) {
      return null;
    }
    const data = parseJsonWith(await res.text(), PkgVersionSchema);
    return data?.version ?? null;
  });
  return fallback.ok ? fallback.data : null;
}

function parseSemver(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10) || 0);
}

function compareVersions(current: string, latest: string): boolean {
  // Simple semantic version comparison (assumes format: major.minor.patch)
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

function isUpdateBackedOff(): boolean {
  return unwrapOr(
    tryCatchIf(isFileError, () => {
      const failedPath = getUpdateFailedPath();
      const content = fs.readFileSync(failedPath, "utf8").trim();
      const failedAt = Number.parseInt(content, 10);
      if (Number.isNaN(failedAt)) {
        return false;
      }
      return Date.now() - failedAt < UPDATE_BACKOFF_MS;
    }),
    false,
  );
}

function markUpdateFailed(): void {
  tryCatchIf(isFileError, () => {
    const failedPath = getUpdateFailedPath();
    fs.mkdirSync(path.dirname(failedPath), {
      recursive: true,
    });
    fs.writeFileSync(failedPath, String(Date.now()));
  });
}

function clearUpdateFailed(): void {
  tryCatchIf(isFileError, () => {
    fs.unlinkSync(getUpdateFailedPath());
  });
}

// ── Success Cache ───────────────────────────────────────────────────────────

function isUpdateCheckedRecently(): boolean {
  return unwrapOr(
    tryCatchIf(isFileError, () => {
      const checkedPath = getUpdateCheckedPath();
      const content = fs.readFileSync(checkedPath, "utf8").trim();
      const checkedAt = Number.parseInt(content, 10);
      if (Number.isNaN(checkedAt)) {
        return false;
      }
      return Date.now() - checkedAt < UPDATE_CHECK_INTERVAL_MS;
    }),
    false,
  );
}

function markUpdateChecked(): void {
  tryCatchIf(isFileError, () => {
    const checkedPath = getUpdateCheckedPath();
    fs.mkdirSync(path.dirname(checkedPath), {
      recursive: true,
    });
    fs.writeFileSync(checkedPath, String(Date.now()));
  });
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
 * Show a non-blocking update notice without auto-installing.
 * Users can update manually with `spawn update` or set SPAWN_AUTO_UPDATE=1.
 */
function printUpdateNotice(latestVersion: string): void {
  console.error();
  console.error(
    pc.yellow("  Update available: ") +
      pc.dim(`v${VERSION}`) +
      pc.yellow(" → ") +
      pc.green(pc.bold(`v${latestVersion}`)),
  );
  console.error(
    pc.dim(`  Run ${pc.cyan("spawn update")} to install, or set SPAWN_AUTO_UPDATE=1 for automatic updates`),
  );
  console.error();
}

/**
 * Find the spawn binary to re-exec after an update.
 *
 * Prefers PATH resolution over process.argv[1] because the installer may place
 * the new binary in a different directory than where the currently running
 * binary lives, causing re-exec to run the stale old binary.
 *
 * Uses `where` on Windows, `which` on macOS/Linux.
 */
function findUpdatedBinary(): string {
  const whichCmd = getWhichCommand();
  const r = tryCatch(() =>
    executor.execFileSync(
      whichCmd,
      [
        "spawn",
      ],
      {
        encoding: "utf8",
        stdio: [
          "pipe",
          "pipe",
          "ignore",
        ],
      },
    ),
  );
  // `where` on Windows may return multiple lines; take the first
  const found = r.ok && r.data ? r.data.toString().trim().split("\n")[0].trim() : "";
  if (found) {
    return found;
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

  const r = tryCatch(() =>
    executor.execFileSync(binPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        SPAWN_NO_UPDATE_CHECK: "1",
        SPAWN_CLI_UPDATED: "1",
      },
    }),
  );
  if (r.ok) {
    process.exit(0);
  } else {
    const code = hasStatus(r.error) ? r.error.status : 1;
    process.exit(code);
  }
}

/**
 * Validate a downloaded install script before execution.
 *
 * Checks:
 * 1. Non-empty and above a minimum size threshold (rejects truncated downloads)
 * 2. Starts with the expected shebang / header for its platform
 *
 * Security note: This is NOT a substitute for cryptographic integrity
 * verification (SHA256 checksum or code signing). The release pipeline does
 * not currently publish checksums for the install script, so we rely on
 * HTTPS (TLS) for transport integrity. These checks catch corruption or
 * truncation, not a compromised CDN. See GitHub issue #3297.
 */
function validateInstallScript(content: string, platform: "unix" | "windows"): void {
  if (content.length < MIN_INSTALL_SCRIPT_BYTES) {
    throw new Error(
      `Install script too small (${content.length} bytes, minimum ${MIN_INSTALL_SCRIPT_BYTES}). ` +
        "Download may be corrupted or truncated.",
    );
  }

  if (platform === "unix") {
    if (!content.startsWith("#!/")) {
      throw new Error("Install script missing expected shebang (#!/...). Download may be corrupted.");
    }
  } else {
    // PowerShell scripts should contain recognizable PS content
    if (!content.includes("$") && !content.includes("function")) {
      throw new Error("Install script does not appear to be valid PowerShell. Download may be corrupted.");
    }
  }
}

function performAutoUpdate(latestVersion: string, jsonOutput = false): void {
  printUpdateBanner(latestVersion);

  const installUrl = getInstallScriptUrl(SPAWN_CDN);
  const installCmd = getInstallCmd(SPAWN_CDN);

  // When JSON output is active, redirect install script stdout to stderr to
  // avoid polluting stdout with [spawn] install messages before the JSON result.
  const installStdio: ExecFileSyncOptions["stdio"] = jsonOutput
    ? [
        "pipe",
        process.stderr,
        process.stderr,
      ]
    : "inherit";

  const updateResult = tryCatch(() => {
    // Fetch script bytes with curl (available on all modern platforms)
    const scriptBytes = executor.execFileSync(
      "curl",
      [
        "--proto",
        "=https",
        "-fsSL",
        installUrl,
      ],
      {
        encoding: "utf8",
        stdio: [
          "pipe",
          "pipe",
          "inherit",
        ],
      },
    );
    const scriptContent = scriptBytes ? scriptBytes.toString() : "";
    const platform = isWindows() ? "windows" : "unix";
    validateInstallScript(scriptContent, platform);

    // Write install script to temp file, execute, and guarantee cleanup.
    // Uses tryCatch so cleanup always runs before any error is re-thrown.
    const tmpExt = isWindows() ? "ps1" : "sh";
    const tmpFile = path.join(tmpdir(), `spawn-install-${Date.now()}.${tmpExt}`);
    fs.writeFileSync(
      tmpFile,
      scriptContent,
      isWindows()
        ? undefined
        : {
            mode: 0o700,
          },
    );

    const execResult = tryCatch(() => {
      if (isWindows()) {
        executor.execFileSync(
          "powershell.exe",
          [
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            tmpFile,
          ],
          {
            stdio: installStdio,
          },
        );
      } else {
        executor.execFileSync(
          "bash",
          [
            tmpFile,
          ],
          {
            stdio: installStdio,
          },
        );
      }
    });

    // Cleanup runs unconditionally — tryCatch above captures any exec error
    // without short-circuiting, so we always reach this line.
    tryCatchIf(isFileError, () => fs.unlinkSync(tmpFile));

    if (!execResult.ok) {
      throw execResult.error;
    }
  });

  if (updateResult.ok) {
    console.error();
    console.error(pc.green(pc.bold(`${CHECK_MARK} Updated successfully!`)));
    clearUpdateFailed();
    reExecWithArgs();
  } else {
    markUpdateFailed();
    console.error();
    console.error(pc.red(pc.bold(`${CROSS_MARK} Auto-update failed`)));
    console.error(pc.dim("  Please update manually:"));
    console.error();
    console.error(pc.cyan(`  ${installCmd}`));
    console.error();
    // Continue with original command despite update failure
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Check for updates and auto-update if available.
 * Caches successful checks for 1 hour to avoid blocking every run with network I/O.
 *
 * @param jsonOutput - When true, redirects install script stdout to stderr so
 *   [spawn] install messages do not pollute structured JSON output on stdout.
 */
export async function checkForUpdates(jsonOutput = false): Promise<void> {
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

  // Skip if we already checked successfully within the last hour
  if (isUpdateCheckedRecently()) {
    return;
  }

  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    return;
  }

  // Record successful check so we don't hit the network again for an hour
  markUpdateChecked();

  // Notify (or auto-install) if a newer version is available.
  if (compareVersions(VERSION, latestVersion)) {
    // Update policy:
    //
    //   PATCH and MINOR bumps (e.g. 1.0.5 → 1.0.7, 1.0.x → 1.1.0) are
    //   auto-installed. These contain bug fixes, security hardening, and
    //   new features that users benefit from getting promptly.
    //
    //   MAJOR bumps (e.g. 1.x.x → 2.0.0) respect SPAWN_AUTO_UPDATE=1
    //   as opt-in, since these can contain breaking changes.
    //
    //   SPAWN_NO_AUTO_UPDATE=1 lets users opt OUT of auto-update entirely
    //   if they need a fully pinned CLI (CI environments, etc.).
    const sameMajor = parseSemver(VERSION)[0] === parseSemver(latestVersion)[0];
    const explicitOptOut = process.env.SPAWN_NO_AUTO_UPDATE === "1";
    const explicitOptIn = process.env.SPAWN_AUTO_UPDATE === "1";

    const shouldAutoInstall = !explicitOptOut && (sameMajor || explicitOptIn);

    if (shouldAutoInstall) {
      const r = tryCatch(() => performAutoUpdate(latestVersion, jsonOutput));
      if (!r.ok) {
        logWarn("Auto-update encountered an error");
        logDebug(getErrorMessage(r.error));
      }
    } else {
      // Major bump without opt-in, or explicit opt-out — show notice.
      printUpdateNotice(latestVersion);
    }
  }
}
