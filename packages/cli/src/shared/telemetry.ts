// shared/telemetry.ts — PostHog telemetry for errors, warnings, and crashes.
// Default on. Disable with SPAWN_TELEMETRY=0.
// Strictly errors/warnings/crashes — no command tracking, no session events.

import { asyncTryCatch } from "./result.js";

// Same PostHog project as feedback.ts
const POSTHOG_TOKEN = "phc_7ToS2jDeWBlMu4n2JoNzoA1FnArdKwFMFoHVnAqQ6O1";
const POSTHOG_URL = "https://us.i.posthog.com/batch/";

// Patterns to scrub from error messages before sending
const SENSITIVE_PATTERNS: [
  RegExp,
  string,
][] = [
  // API keys: sk-or-v1-..., sk-ant-..., sk-..., key-...
  [
    /\b(sk-or-v1-|sk-ant-api03-|sk-|key-)[A-Za-z0-9_-]{10,}\b/g,
    "[REDACTED_KEY]",
  ],
  // GitHub tokens: ghp_..., gho_..., github_pat_...
  [
    /\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{10,}\b/g,
    "[REDACTED_GITHUB_TOKEN]",
  ],
  // Bearer tokens in headers
  [
    /Bearer\s+[A-Za-z0-9_.\-/+=]{10,}/gi,
    "Bearer [REDACTED]",
  ],
  // Email addresses
  [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]",
  ],
  // IP addresses (IPv4)
  [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    "[REDACTED_IP]",
  ],
  // Hetzner/DO/cloud API tokens (64-char hex or similar)
  [
    /\b[A-Za-z0-9]{60,}\b/g,
    "[REDACTED_TOKEN]",
  ],
  // Base64-encoded blobs that might contain secrets (40+ chars)
  [
    /[A-Za-z0-9+/]{40,100}={0,2}/g,
    "[REDACTED_B64]",
  ],
  // Home directory paths — replace with ~
  [
    /\/(?:home|Users)\/[a-zA-Z0-9._-]+/g,
    "~/[USER]",
  ],
];

/**
 * Parse a JS Error stack string into PostHog stack frames.
 * Each line like "    at functionName (filename:line:col)" becomes a frame.
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

interface TelemetryEvent {
  event: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

// ── State ───────────────────────────────────────────────────────────────────

let _enabled = true;
let _sessionId = "";
let _context: Record<string, string> = {};
const _events: TelemetryEvent[] = [];
let _flushScheduled = false;

// ── Public API ──────────────────────────────────────────────────────────────

/** Initialize telemetry. Call once at startup. */
export function initTelemetry(version: string): void {
  _enabled = process.env.SPAWN_TELEMETRY !== "0";
  if (!_enabled) {
    return;
  }

  _sessionId = crypto.randomUUID();
  _context = {
    spawn_version: version,
    os: process.platform,
    arch: process.arch,
  };

  // Capture uncaught errors
  process.on("uncaughtException", (err) => {
    captureError("uncaught_exception", err);
    flushSync();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    captureError("unhandled_rejection", reason);
  });

  // Flush buffered events before exit
  process.on("beforeExit", () => {
    flushSync();
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
  pushEvent("cli_warning", {
    message: scrub(message),
  });
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

  pushEvent("$exception", {
    $exception_list: [
      exceptionEntry,
    ],
    $exception_level: "error",
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

function pushEvent(event: string, properties: Record<string, unknown>): void {
  _events.push({
    event,
    timestamp: new Date().toISOString(),
    properties: {
      ..._context,
      ...properties,
      $session_id: _sessionId,
    },
  });

  // Schedule a flush — batch events that happen in quick succession
  if (!_flushScheduled && _events.length >= 10) {
    _flushScheduled = true;
    setTimeout(() => {
      _flushScheduled = false;
      flush();
    }, 1000);
  }
}

/** Async flush — best effort, doesn't block. */
function flush(): void {
  if (_events.length === 0) {
    return;
  }
  const batch = _events.splice(0);
  sendBatch(batch);
}

/** Sync-safe flush for exit handlers. Uses fetch without await. */
function flushSync(): void {
  if (_events.length === 0) {
    return;
  }
  const batch = _events.splice(0);
  sendBatch(batch);
}

function sendBatch(batch: TelemetryEvent[]): void {
  const body = JSON.stringify({
    api_key: POSTHOG_TOKEN,
    batch: batch.map((e) => ({
      event: e.event,
      timestamp: e.timestamp,
      properties: {
        ...e.properties,
        distinct_id: _sessionId,
      },
    })),
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
