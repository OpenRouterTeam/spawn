// fly/lib/ui.ts — Logging, prompts, and browser opening (zero external deps)

import { createInterface } from "readline";

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

/** Prompt for a line of user input. Throws if non-interactive. */
export async function prompt(question: string): Promise<string> {
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    throw new Error("Cannot prompt: SPAWN_NON_INTERACTIVE is set");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve, reject) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    rl.on("error", reject);
    rl.on("close", () => resolve(""));
  });
}

/**
 * Display a numbered list from pipe-delimited items and let the user pick one.
 * Items format: "id|label" per line.
 * Returns the selected id.
 */
export async function selectFromList(
  items: string[],
  promptText: string,
  defaultValue: string,
): Promise<string> {
  if (items.length === 0) return defaultValue;
  if (items.length === 1) {
    const id = items[0].split("|")[0];
    logInfo(`Using ${promptText}: ${id}`);
    return id;
  }

  logStep(`Available ${promptText}:`);
  const parsed = items.map((line) => {
    const parts = line.split("|");
    return { id: parts[0], label: parts.slice(1).join(" — ") };
  });

  let defaultIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    const marker = parsed[i].id === defaultValue ? " (default)" : "";
    if (parsed[i].id === defaultValue) defaultIdx = i;
    process.stderr.write(`  ${i + 1}. ${parsed[i].id} — ${parsed[i].label}${marker}\n`);
  }

  const answer = await prompt(
    `Select ${promptText} [${defaultIdx >= 0 ? defaultIdx + 1 : 1}]: `,
  );
  if (!answer) return defaultValue;

  const num = parseInt(answer, 10);
  if (num >= 1 && num <= parsed.length) return parsed[num - 1].id;
  // Maybe they typed the id directly
  const match = parsed.find((p) => p.id === answer);
  if (match) return match.id;
  return defaultValue;
}

/** Open a URL in the user's browser. */
export function openBrowser(url: string): void {
  const cmds: [string, string[]][] =
    process.platform === "darwin"
      ? [["open", [url]]]
      : [
          ["xdg-open", [url]],
          ["termux-open-url", [url]],
        ];

  for (const [cmd, args] of cmds) {
    try {
      Bun.spawnSync([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] });
      return;
    } catch {
      // try next
    }
  }
  logStep(`Please open: ${url}`);
}

/** JSON-escape a string (returns the quoted JSON string). */
export function jsonEscape(s: string): string {
  return JSON.stringify(s);
}

/** Validate server name: 3-63 chars, alphanumeric + dash, no leading/trailing dash. */
export function validateServerName(name: string): boolean {
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-zA-Z0-9-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("-")) return false;
  return true;
}

/** Validate region name: 1-63 chars, alphanumeric + dash + underscore. */
export function validateRegionName(region: string): boolean {
  return /^[a-zA-Z0-9_-]{1,63}$/.test(region);
}

/** Validate model ID format. */
export function validateModelId(id: string): boolean {
  if (!id) return true;
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
