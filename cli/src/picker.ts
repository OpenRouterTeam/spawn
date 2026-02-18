/**
 * picker.ts — Modular interactive option picker.
 *
 * Two modes:
 *   pickToTTY(config)  — renders arrow-key UI to /dev/tty, writes result to
 *                        stdout.  Works even when stdout is captured by bash
 *                        `result=$(spawn pick ...)` and stdin is piped.
 *   pickFallback(config) — numbered list on stderr for non-TTY environments.
 *
 * Input format (stdin lines or --options strings):
 *   "value\tLabel\tHint"  (tab-separated; hint is optional)
 *   "value\tLabel"
 *   "value"               (label defaults to value)
 *
 * Usage from bash:
 *   zone=$(printf 'us-central1-a\tIowa\nus-east1-b\tVirginia' \
 *            | spawn pick --prompt "Select zone" --default "us-central1-a")
 */

import * as fs from "fs";
import { spawnSync } from "child_process";

export interface PickOption {
  value: string;
  label: string;
  hint?: string;
}

export interface PickConfig {
  message: string;
  options: PickOption[];
  defaultValue?: string;
}

/**
 * Parse piped input into picker options.
 * Each line: "value\tLabel\tHint" — tab-separated; hint is optional.
 */
export function parsePickerInput(text: string): PickOption[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const parts = l.split("\t");
      const value = (parts[0] ?? "").trim();
      const label = (parts[1] ?? value).trim();
      const hint = parts[2]?.trim();
      return { value, label, ...(hint ? { hint } : {}) };
    })
    .filter((o) => o.value.length > 0);
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const A = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  green:     "\x1b[32m",
  cyan:      "\x1b[36m",
  hideC:     "\x1b[?25l",
  showC:     "\x1b[?25h",
  clearBelow:"\x1b[J",
  up: (n: number) => `\x1b[${n}A`,
  col1:      "\x1b[1G",
};

// ── TTY picker ────────────────────────────────────────────────────────────────

/**
 * Render an arrow-key picker directly on /dev/tty so it works even when
 * stdout is captured.  Returns the selected value, or null on cancel.
 *
 * This function is synchronous internally (blocking readSync loop on the tty
 * fd) but returns void so callers can `await` it uniformly.
 */
export function pickToTTY(config: PickConfig): string | null {
  if (config.options.length === 0) return config.defaultValue ?? null;

  // ── open /dev/tty ──────────────────────────────────────────────────────────
  let ttyFd: number;
  try {
    ttyFd = fs.openSync("/dev/tty", "r+");
  } catch {
    return pickFallback(config);
  }

  // ── save terminal settings ────────────────────────────────────────────────
  const savedRes = spawnSync("stty", ["-g"], {
    stdio: [ttyFd, "pipe", "pipe"],
  });
  if (savedRes.status !== 0 || !savedRes.stdout) {
    fs.closeSync(ttyFd);
    return pickFallback(config);
  }
  const savedSettings = savedRes.stdout.toString().trim();

  // ── enable raw / no-echo mode ─────────────────────────────────────────────
  const rawRes = spawnSync("stty", ["raw", "-echo"], {
    stdio: [ttyFd, "pipe", "pipe"],
  });
  if (rawRes.status !== 0) {
    fs.closeSync(ttyFd);
    return pickFallback(config);
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  const w = (s: string) => { try { fs.writeSync(ttyFd, s); } catch {} };

  const restore = () => {
    try { spawnSync("stty", [savedSettings], { stdio: [ttyFd, "pipe", "pipe"] }); } catch {}
    w(A.showC);
    try { fs.closeSync(ttyFd); } catch {}
  };

  // ── initial state ─────────────────────────────────────────────────────────
  let selected = 0;
  if (config.defaultValue) {
    const idx = config.options.findIndex((o) => o.value === config.defaultValue);
    if (idx >= 0) selected = idx;
  }

  // header line + one line per option + footer line
  const pickerHeight = config.options.length + 2;

  const render = (first: boolean) => {
    if (!first) {
      w(A.up(pickerHeight) + A.col1 + A.clearBelow);
    }
    w(`${A.bold}${A.cyan}? ${config.message}${A.reset}\r\n`);
    for (let i = 0; i < config.options.length; i++) {
      const opt = config.options[i];
      if (i === selected) {
        w(`${A.green}${A.bold}> ${opt.label}${A.reset}`);
        if (opt.hint) w(`  ${A.dim}${opt.hint}${A.reset}`);
      } else {
        w(`  ${A.dim}${opt.label}${A.reset}`);
      }
      w("\r\n");
    }
    w(`${A.dim}  \u2191/\u2193 move  \u23ce select  Ctrl-C cancel${A.reset}\r\n`);
  };

  // ── render & key loop ─────────────────────────────────────────────────────
  w(A.hideC);
  render(true);

  const buf = Buffer.alloc(8);
  let result: string | null = null;

  try {
    // Synchronous blocking read loop — each iteration waits for one keypress.
    // Arrow keys (\x1b[A / \x1b[B) arrive as a single read() because the
    // terminal driver delivers escape sequences atomically.
    outer: while (true) {
      let n: number;
      try {
        n = fs.readSync(ttyFd, buf, 0, 8);
      } catch {
        break;
      }
      if (n === 0) continue;

      const key = buf.slice(0, n).toString("binary");

      switch (key) {
        // ── cancel ─────────────────────────────────────────────────────────
        case "\x03": // Ctrl-C
        case "\x1b": // standalone Escape
          break outer;

        // ── confirm ────────────────────────────────────────────────────────
        case "\r":
        case "\n": {
          result = config.options[selected].value;
          // Replace picker with a one-line confirmation
          w(A.up(pickerHeight) + A.col1 + A.clearBelow);
          const opt = config.options[selected];
          w(
            `${A.green}${A.bold}> ${config.message}:${A.reset} ` +
            `${A.cyan}${opt.label}${A.reset}\r\n`
          );
          break outer;
        }

        // ── navigation ─────────────────────────────────────────────────────
        case "\x1b[A": // Up (CSI)
        case "\x1bOA": // Up (SS3, some terminals)
        case "k":      // vim-style
          selected = (selected - 1 + config.options.length) % config.options.length;
          render(false);
          break;

        case "\x1b[B": // Down (CSI)
        case "\x1bOB": // Down (SS3)
        case "j":      // vim-style
          selected = (selected + 1) % config.options.length;
          render(false);
          break;

        default:
          break;
      }
    }
  } finally {
    restore();
  }

  return result;
}

// ── fallback picker ───────────────────────────────────────────────────────────

/**
 * Simple numbered-list fallback when no /dev/tty is available.
 * Renders to stderr, reads from /dev/tty or stdin.
 */
export function pickFallback(config: PickConfig): string | null {
  const { message, options, defaultValue } = config;
  if (options.length === 0) return defaultValue ?? null;

  const defaultIdx = Math.max(
    options.findIndex((o) => o.value === defaultValue) + 1,
    1
  );

  process.stderr.write(`\n${message}\n`);
  options.forEach((opt, i) => {
    const marker = opt.value === defaultValue ? "*" : " ";
    let line = `  ${marker} ${i + 1}) ${opt.label}`;
    if (opt.hint) line += `  — ${opt.hint}`;
    process.stderr.write(line + "\n");
  });
  process.stderr.write(`\nSelect [${defaultIdx}]: `);

  // Attempt to read from /dev/tty (stdin may be piped with options)
  let inputFd = 0;
  let openedTTY = false;
  try {
    const fd = fs.openSync("/dev/tty", "r");
    inputFd = fd;
    openedTTY = true;
  } catch {
    // fall through: read from stdin (fd 0)
  }

  let line = "";
  try {
    const lb = Buffer.alloc(256);
    const n = fs.readSync(inputFd, lb, 0, 255);
    line = lb.slice(0, n).toString().replace(/[\r\n]/g, "").trim();
  } catch {
    // ignore
  } finally {
    if (openedTTY) try { fs.closeSync(inputFd); } catch {}
  }

  const choice = parseInt(line, 10);
  if (choice >= 1 && choice <= options.length) {
    return options[choice - 1].value;
  }
  return defaultValue ?? options[0]?.value ?? null;
}
