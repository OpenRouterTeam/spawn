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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

export interface PickOption {
  value: string;
  label: string;
  hint?: string;
  subtitle?: string;
}

export interface PickConfig {
  message: string;
  options: PickOption[];
  defaultValue?: string;
  deleteKey?: boolean;
}

export interface PickResult {
  action: "select" | "delete" | "cancel";
  value: string | null;
  index: number;
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
      return {
        value,
        label,
        ...(hint
          ? {
              hint,
            }
          : {}),
      };
    })
    .filter((o) => o.value.length > 0);
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  hideC: "\x1b[?25l",
  showC: "\x1b[?25h",
  clearBelow: "\x1b[J",
  up: (n: number) => `\x1b[${n}A`,
  col1: "\x1b[1G",
};

/** Truncate a string to `max` visible characters, adding \u2026 if needed. */
const trunc = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, Math.max(max - 1, 0)) + "\u2026");

/** Get terminal column width from a tty file descriptor. */
function getTTYCols(ttyFd: number): number {
  try {
    const res = spawnSync(
      "stty",
      [
        "size",
      ],
      {
        stdio: [
          ttyFd,
          "pipe",
          "pipe",
        ],
      },
    );
    if (res.status === 0 && res.stdout) {
      const parts = res.stdout.toString().trim().split(/\s+/);
      if (parts.length >= 2) {
        const c = Number.parseInt(parts[1], 10);
        if (c > 0) {
          return c;
        }
      }
    }
  } catch {}
  return 80;
}

// ── Shared TTY key-loop infrastructure ───────────────────────────────────────

type WriteFn = (s: string) => void;

interface KeyLoopCallbacks<T> {
  fallback: () => T;
  cancel: () => T;
  init: (w: WriteFn, cols: number) => void;
  handleKey: (
    key: string,
    w: WriteFn,
  ) => {
    done: boolean;
    result?: T;
  };
}

/**
 * Opens /dev/tty, saves/restores stty settings, enables raw mode,
 * and runs a synchronous key-read loop. Delegates all rendering and
 * key handling to the provided callbacks.
 *
 * Returns `fallback()` if /dev/tty or stty setup fails.
 */
function withTTYKeyLoop<T>(callbacks: KeyLoopCallbacks<T>): T {
  // ── open /dev/tty ────────────────────────────────────────────────────────
  let ttyFd: number;
  try {
    ttyFd = fs.openSync("/dev/tty", "r+");
  } catch {
    return callbacks.fallback();
  }

  // ── save terminal settings ──────────────────────────────────────────────
  const savedRes = spawnSync(
    "stty",
    [
      "-g",
    ],
    {
      stdio: [
        ttyFd,
        "pipe",
        "pipe",
      ],
    },
  );
  if (savedRes.status !== 0 || !savedRes.stdout) {
    fs.closeSync(ttyFd);
    return callbacks.fallback();
  }
  const savedSettings = savedRes.stdout.toString().trim();

  // ── enable raw / no-echo mode ───────────────────────────────────────────
  const rawRes = spawnSync(
    "stty",
    [
      "raw",
      "-echo",
    ],
    {
      stdio: [
        ttyFd,
        "pipe",
        "pipe",
      ],
    },
  );
  if (rawRes.status !== 0) {
    fs.closeSync(ttyFd);
    return callbacks.fallback();
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  const w: WriteFn = (s) => {
    try {
      fs.writeSync(ttyFd, s);
    } catch {}
  };

  const restore = () => {
    try {
      spawnSync(
        "stty",
        [
          savedSettings,
        ],
        {
          stdio: [
            ttyFd,
            "pipe",
            "pipe",
          ],
        },
      );
    } catch {}
    w(A.showC);
    try {
      fs.closeSync(ttyFd);
    } catch {}
  };

  // ── init (first render) ─────────────────────────────────────────────────
  const cols = getTTYCols(ttyFd);
  w(A.hideC);
  callbacks.init(w, cols);

  // ── key loop ────────────────────────────────────────────────────────────
  const buf = Buffer.alloc(8);
  let finalResult: T | undefined;
  let cancelled = false;

  try {
    while (true) {
      let n: number;
      try {
        n = fs.readSync(ttyFd, buf, 0, 8, null);
      } catch {
        break;
      }
      if (n === 0) {
        continue;
      }

      const key = buf.slice(0, n).toString("binary");

      // Ctrl-C / Escape — explicit user cancel (not a TTY failure)
      if (key === "\x03" || key === "\x1b") {
        cancelled = true;
        break;
      }

      const action = callbacks.handleKey(key, w);
      if (action.done) {
        finalResult = action.result;
        break;
      }
    }
  } finally {
    restore();
  }

  if (finalResult !== undefined) {
    return finalResult;
  }
  return cancelled ? callbacks.cancel() : callbacks.fallback();
}

// ── TTY picker ────────────────────────────────────────────────────────────────

/**
 * Render an arrow-key picker directly on /dev/tty so it works even when
 * stdout is captured.  Returns the selected value, or null on cancel.
 *
 * This function is synchronous internally (blocking readSync loop on the tty
 * fd) but returns void so callers can `await` it uniformly.
 */
export function pickToTTY(config: PickConfig): string | null {
  const result = pickToTTYWithActions(config);
  return result.action === "select" ? result.value : null;
}

/**
 * Like pickToTTY but returns a PickResult with action discrimination.
 * When deleteKey is enabled, pressing 'd' returns { action: "delete" }.
 */
export function pickToTTYWithActions(config: PickConfig): PickResult {
  const cancel: PickResult = {
    action: "cancel",
    value: null,
    index: -1,
  };

  if (config.options.length === 0) {
    return config.defaultValue
      ? {
          action: "select",
          value: config.defaultValue,
          index: 0,
        }
      : cancel;
  }

  const fallback = (): PickResult => {
    const val = pickFallback(config);
    return val
      ? {
          action: "select",
          value: val,
          index: config.options.findIndex((o) => o.value === val),
        }
      : cancel;
  };

  let selected = 0;
  if (config.defaultValue) {
    const idx = config.options.findIndex((o) => o.value === config.defaultValue);
    if (idx >= 0) {
      selected = idx;
    }
  }

  let maxW = 80;
  let pickerHeight = 0;
  let render: (w: WriteFn, first: boolean) => void;

  return withTTYKeyLoop<PickResult>({
    fallback,
    cancel: () => cancel,

    init(w, cols) {
      maxW = cols - 1;
      const footerHint = config.deleteKey
        ? "\u2191/\u2193 move  \u23ce select  d delete  Ctrl-C cancel"
        : "\u2191/\u2193 move  \u23ce select  Ctrl-C cancel";

      const linesPerOption = config.options.map((o) => (o.subtitle ? 2 : 1));
      // Add 1 blank separator line between each pair of adjacent options
      const separatorCount = config.options.length > 1 ? config.options.length - 1 : 0;
      pickerHeight = 1 + linesPerOption.reduce((a, b) => a + b, 0) + separatorCount + 1;

      render = (wr: WriteFn, first: boolean) => {
        if (!first) {
          wr(A.up(pickerHeight) + A.col1 + A.clearBelow);
        }
        wr(`${A.bold}${A.cyan}? ${trunc(config.message, maxW - 2)}${A.reset}\r\n`);
        for (let i = 0; i < config.options.length; i++) {
          const opt = config.options[i];
          if (i === selected) {
            const label = trunc(opt.label, maxW - 2);
            wr(`${A.green}${A.bold}> ${label}${A.reset}`);
            if (!opt.subtitle && opt.hint) {
              const remaining = maxW - 2 - label.length - 2;
              if (remaining > 3) {
                wr(`  ${A.dim}${trunc(opt.hint, remaining)}${A.reset}`);
              }
            }
            wr("\r\n");
            if (opt.subtitle) {
              wr(`  ${A.dim}${trunc(opt.subtitle, maxW - 2)}${A.reset}\r\n`);
            }
          } else {
            wr(`  ${trunc(opt.label, maxW - 2)}\r\n`);
            if (opt.subtitle) {
              wr(`  ${A.dim}${trunc(opt.subtitle, maxW - 2)}${A.reset}\r\n`);
            }
          }
          // Blank separator between entries for visual clarity
          if (i < config.options.length - 1) {
            wr("\r\n");
          }
        }
        wr(`${A.dim}  ${trunc(footerHint, maxW - 2)}${A.reset}\r\n`);
      };

      render(w, true);
    },

    handleKey(key, w) {
      switch (key) {
        case "\r":
        case "\n": {
          const result: PickResult = {
            action: "select",
            value: config.options[selected].value,
            index: selected,
          };
          w(A.up(pickerHeight) + A.col1 + A.clearBelow);
          const opt = config.options[selected];
          w(
            `${A.green}${A.bold}> ${config.message}:${A.reset} ${A.cyan}${trunc(opt.label, maxW - config.message.length - 4)}${A.reset}\r\n`,
          );
          return {
            done: true,
            result,
          };
        }

        case "d":
          if (config.deleteKey) {
            const result: PickResult = {
              action: "delete",
              value: config.options[selected].value,
              index: selected,
            };
            w(A.up(pickerHeight) + A.col1 + A.clearBelow);
            return {
              done: true,
              result,
            };
          }
          return {
            done: false,
          };

        case "\x1b[A":
        case "\x1bOA":
        case "k":
          selected = (selected - 1 + config.options.length) % config.options.length;
          render(w, false);
          return {
            done: false,
          };

        case "\x1b[B":
        case "\x1bOB":
        case "j":
          selected = (selected + 1) % config.options.length;
          render(w, false);
          return {
            done: false,
          };

        default:
          return {
            done: false,
          };
      }
    },
  });
}

// ── fallback picker ───────────────────────────────────────────────────────────

/**
 * Simple numbered-list fallback when no /dev/tty is available.
 * Renders to stderr, reads from /dev/tty or stdin.
 */
export function pickFallback(config: PickConfig): string | null {
  const { message, options, defaultValue } = config;
  if (options.length === 0) {
    return defaultValue ?? null;
  }

  const defaultIdx = Math.max(options.findIndex((o) => o.value === defaultValue) + 1, 1);

  process.stderr.write(`\n${message}\n`);
  options.forEach((opt, i) => {
    const marker = opt.value === defaultValue ? "*" : " ";
    let line = `  ${marker} ${i + 1}) ${opt.label}`;
    if (opt.hint) {
      line += `  — ${opt.hint}`;
    }
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
    const n = fs.readSync(inputFd, lb, 0, 255, null);
    line = lb
      .slice(0, n)
      .toString()
      .replace(/[\r\n]/g, "")
      .trim();
  } catch {
    // ignore
  } finally {
    if (openedTTY) {
      try {
        fs.closeSync(inputFd);
      } catch {}
    }
  }

  const choice = Number.parseInt(line, 10);
  if (choice >= 1 && choice <= options.length) {
    return options[choice - 1].value;
  }
  return defaultValue ?? options[0]?.value ?? null;
}
