// shared/telemetry.ts — PostHog telemetry for errors, warnings, crashes, and
// low-volume product events (funnel steps, spawn lifecycle).
// Default on. Disable with SPAWN_TELEMETRY=0.
// Never sends command args, file paths, or user prompt content.
// Events are sent immediately — no batching, no lost events on process.exit().

import { isString } from "@openrouter/spawn-shared";
import { getInstallId } from "./install-id.js";
import { asyncTryCatch } from "./result.js";

// Same PostHog project as feedback.ts
const POSTHOG_TOKEN = "phc_7ToS2jDeWBlMu4n2JoNzoA1FnArdKwFMFoHVnAqQ6O1";
const POSTHOG_URL = "https://us.i.posthog.com/batch/";

// Patterns to scrub from error messages before sending
const SENSITIVE_PATTERNS: [
  RegExp,
  string,
][] = [
  [
    /\b(sk-or-v1-|sk-ant-api03-|sk-|key-)[A-Za-z0-9_-]{10,}\b/g,
    "[REDACTED_KEY]",
  ],
  [
    /\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{10,}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  ],
  [
    /Bearer\s+[A-Za-z0-9_.\-/+=]{10,}/gi,
    "Bearer [REDACTED]",
  ],
  [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]",
  ],
  [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    "[REDACTED_IP]",
  ],
  [
    /\b[A-Za-z0-9]{60,}\b/g,
    "[REDACTED_TOKEN]",
  ],
  [
    /[A-Za-z0-9+/]{40,100}={0,2}/g,
    "[REDACTED_B64]",
  ],
  [
    /\/(?:home|Users)\/[a-zA-Z0-9._-]+/g,
    "~/[USER]",
  ],
];

/**
 * Parse a JS Error stack string into PostHog stack frames.
 */
function parseStackFrames(stack: string): {
  platform: string;
  function: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}[] {
  const frames: {
    platform: string;
    function: string;
    filename: string;
    lineno?: number;
    colno?: number;
    in_app: boolean;
  }[] = [];
  for (const line of stack.split("\n")) {
    const match = /^\s+at\s+(?:(.+?)\s+\((.+?):(\d+):(\d+)\)|(.+?):(\d+):(\d+))/.exec(line);
    if (!match) {
      continue;
    }
    const fn = match[1] || "<anonymous>";
    const file = scrub(match[2] || match[5] || "<unknown>");
    const lineno = Number(match[3] || match[6]);
    const colno = Number(match[4] || match[7]);
    frames.push({
      platform: "node:javascript",
      function: fn,
      filename: file,
      ...(lineno
        ? {
            lineno,
          }
        : {}),
      ...(colno
        ? {
            colno,
          }
        : {}),
      in_app: !file.includes("node_modules"),
    });
  }
  return frames;
}

/** Scrub sensitive data from a string before sending to telemetry. */
function scrub(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── State ───────────────────────────────────────────────────────────────────

// Telemetry is OPT-IN: nothing fires until initTelemetry() is called.
let _enabled = false;
let _userId = "";
let _sessionId = "";
let _context: Record<string, string> = {};

// Persistent user ID is provided by shared/install-id.ts so feature flags and
// telemetry share the same PostHog identity.

// ── Public API ──────────────────────────────────────────────────────────────

/** Initialize telemetry. Call once at startup. */
export function initTelemetry(version: string): void {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    _enabled = false;
    return;
  }

  _enabled = process.env.SPAWN_TELEMETRY !== "0";
  if (!_enabled) {
    return;
  }

  // Persistent user ID — same across all runs (shared with feature flags)
  _userId = getInstallId();

  // Session ID — shared between parent and child processes within one spawn run
  _sessionId = process.env.SPAWN_TELEMETRY_SESSION || crypto.randomUUID();
  process.env.SPAWN_TELEMETRY_SESSION = _sessionId;

  _context = {
    spawn_version: version,
    os: process.platform,
    arch: process.arch,
    source: "cli",
  };

  // Capture uncaught errors
  process.on("uncaughtException", (err) => {
    captureError("uncaught_exception", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    captureError("unhandled_rejection", reason);
  });
}

/** Set session context (agent, cloud, etc.). Call as info becomes available. */
export function setTelemetryContext(key: string, value: string): void {
  if (!_enabled) {
    return;
  }
  _context[key] = value;
}

/** Capture a warning event. */
export function captureWarning(message: string): void {
  if (!_enabled) {
    return;
  }
  sendEvent("cli_warning", {
    message: scrub(message),
  });
}

/**
 * Capture a generic telemetry event (funnel steps, lifecycle events, etc.).
 */
export function captureEvent(event: string, properties: Record<string, unknown> = {}): void {
  if (!_enabled) {
    return;
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    scrubbed[key] = isString(value) ? scrub(value) : value;
  }
  sendEvent(event, scrubbed);
}

/** Map our error types to PostHog mechanism types. */
function mechanismType(type: string): string {
  switch (type) {
    case "uncaught_exception":
      return "onuncaughtexception";
    case "unhandled_rejection":
      return "onunhandledrejection";
    default:
      return "generic";
  }
}

/** Capture an error as a $exception event (shows in PostHog Error Tracking). */
export function captureError(type: string, err: unknown): void {
  if (!_enabled) {
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const scrubbedMessage = scrub(message);

  const exceptionEntry: Record<string, unknown> = {
    type,
    value: scrubbedMessage,
    mechanism: {
      handled: type === "log_error",
      type: mechanismType(type),
      synthetic: !(err instanceof Error),
    },
  };

  if (stack) {
    const frames = parseStackFrames(stack);
    if (frames.length > 0) {
      exceptionEntry.stacktrace = {
        type: "raw",
        frames,
      };
    }
  }

  sendEvent("$exception", {
    $exception_list: [
      exceptionEntry,
    ],
    $exception_level: "error",
  });
}

// ── Send ────────────────────────────────────────────────────────────────────

/** Send a single event to PostHog immediately. Fire-and-forget. */
function sendEvent(event: string, properties: Record<string, unknown>): void {
  const body = JSON.stringify({
    api_key: POSTHOG_TOKEN,
    batch: [
      {
        event,
        timestamp: new Date().toISOString(),
        properties: {
          ..._context,
          ...properties,
          distinct_id: _userId,
          $session_id: _sessionId,
        },
      },
    ],
  });

  // Fire-and-forget — never block the CLI on telemetry
  asyncTryCatch(() =>
    fetch(POSTHOG_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(5_000),
    }),
  );
}
