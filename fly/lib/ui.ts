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
 * Display an interactive picker from pipe-delimited items.
 * Items format: "id|label" per line.
 * Uses arrow keys + Enter for selection, with type-to-filter support.
 * Falls back to numbered list if TTY is unavailable.
 * Returns the selected id.
 */
export async function selectFromList(
  items: string[],
  promptText: string,
  defaultValue: string,
): Promise<string> {
  if (items.length === 0) return defaultValue;

  const parsed = items.map((line) => {
    const parts = line.split("|");
    return { id: parts[0], label: parts.slice(1).join(" — ") };
  });

  if (parsed.length === 1) {
    logInfo(`Using ${promptText}: ${parsed[0].id}`);
    return parsed[0].id;
  }

  // Try interactive arrow-key picker if we have a TTY
  if (process.stdin.isTTY && process.env.SPAWN_NON_INTERACTIVE !== "1") {
    try {
      return await arrowKeyPicker(parsed, promptText, defaultValue);
    } catch {
      // fall through to numbered list
    }
  }

  // Fallback: numbered list
  logStep(`Available ${promptText}:`);
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
  const match = parsed.find((p) => p.id === answer);
  if (match) return match.id;
  return defaultValue;
}

/** Interactive arrow-key picker rendered to stderr. */
async function arrowKeyPicker(
  items: { id: string; label: string }[],
  title: string,
  defaultValue: string,
): Promise<string> {
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const INVERT = "\x1b[7m";

  let cursor = Math.max(0, items.findIndex((i) => i.id === defaultValue));
  const maxVisible = Math.min(items.length, Math.max(5, (process.stdout.rows || 20) - 4));

  function render() {
    // Calculate scroll window
    let start = 0;
    if (items.length > maxVisible) {
      start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), items.length - maxVisible));
    }
    const end = Math.min(start + maxVisible, items.length);

    const lines: string[] = [];
    lines.push(`${CYAN}Select ${title}:${NC}  ${DIM}(↑/↓ to move, Enter to select)${NC}`);
    for (let i = start; i < end; i++) {
      const prefix = i === cursor ? `${INVERT}${BOLD} ▸ ` : `   `;
      const suffix = items[i].id === defaultValue ? ` ${DIM}(default)${NC}` : "";
      const reset = i === cursor ? NC : "";
      lines.push(`${prefix}${items[i].id} — ${items[i].label}${reset}${suffix}`);
    }
    if (items.length > maxVisible) {
      const pct = Math.round(((cursor + 1) / items.length) * 100);
      lines.push(`${DIM}  ${items.length} items (${pct}%)${NC}`);
    }

    // Clear previous render, write new one
    process.stderr.write(`\x1b[?25l`); // hide cursor
    // Move up to overwrite previous frame (except first render)
    if ((render as any)._rendered) {
      process.stderr.write(`\x1b[${(render as any)._lines}A\x1b[J`);
    }
    process.stderr.write(lines.join("\n") + "\n");
    (render as any)._rendered = true;
    (render as any)._lines = lines.length;
  }

  return new Promise<string>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    render();

    const onData = (buf: Buffer) => {
      const key = buf.toString();

      if (key === "\x1b[A" || key === "k") {
        // Up
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        // Down
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key === "\r" || key === "\n") {
        // Enter — select
        cleanup();
        resolve(items[cursor].id);
      } else if (key === "\x1b" || key === "\x03") {
        // Escape or Ctrl-C — use default
        cleanup();
        resolve(defaultValue);
      }
    };

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\x1b[?25h"); // show cursor
    }

    stdin.on("data", onData);
  });
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
