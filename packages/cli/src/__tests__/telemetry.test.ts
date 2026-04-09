/**
 * telemetry.test.ts — Tests for the PostHog telemetry module.
 *
 * Verifies:
 * - SPAWN_TELEMETRY=0 disables all telemetry (no fetch calls)
 * - captureWarning sends cli_warning events with scrubbed messages
 * - captureError sends $exception events with proper PostHog structure
 * - Sensitive data (API keys, emails, IPs, tokens) is scrubbed from payloads
 * - Stack frames are parsed into PostHog-compatible format
 * - Context (agent, cloud) is included in event properties
 *
 * NOTE: The telemetry module uses module-level state (_events array) shared
 * across all test files. Other tests that import ui.ts trigger captureWarning
 * calls that accumulate in the same buffer. All lookups therefore filter by
 * unique marker strings to avoid cross-test interference.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isString } from "@openrouter/spawn-shared";

// Import once — module state is shared across tests, which is fine since
// initTelemetry re-initialises all state on each call.
const tel = await import("../shared/telemetry.js");

/**
 * Helper to find a specific warning by message substring in flushed fetch calls.
 * Walks through all fetch mock calls, parses PostHog batch payloads, and returns
 * the first cli_warning event whose message contains the given substring.
 */
function findWarningEvent(
  fetchMockInstance: ReturnType<typeof mock>,
  messageSubstring: string,
): Record<string, unknown> | undefined {
  for (const call of fetchMockInstance.mock.calls) {
    const init = call[1];
    const body = init && typeof init === "object" && "body" in init ? init.body : undefined;
    if (!isString(body)) {
      continue;
    }
    const parsed = JSON.parse(body);
    const batch = parsed.batch;
    if (!Array.isArray(batch)) {
      continue;
    }
    for (const evt of batch) {
      if (evt.event !== "cli_warning") {
        continue;
      }
      const msg = evt.properties?.message;
      if (isString(msg) && msg.includes(messageSubstring)) {
        return evt;
      }
    }
  }
  return undefined;
}

/**
 * Helper to find a specific $exception by value substring in flushed fetch calls.
 */
function findExceptionEvent(
  fetchMockInstance: ReturnType<typeof mock>,
  valueSubstring: string,
): Record<string, unknown> | undefined {
  for (const call of fetchMockInstance.mock.calls) {
    const init = call[1];
    const body = init && typeof init === "object" && "body" in init ? init.body : undefined;
    if (!isString(body)) {
      continue;
    }
    const parsed = JSON.parse(body);
    const batch = parsed.batch;
    if (!Array.isArray(batch)) {
      continue;
    }
    for (const evt of batch) {
      if (evt.event !== "$exception") {
        continue;
      }
      const exList = evt.properties?.$exception_list;
      if (!Array.isArray(exList)) {
        continue;
      }
      for (const entry of exList) {
        if (isString(entry.value) && entry.value.includes(valueSubstring)) {
          return evt;
        }
      }
    }
  }
  return undefined;
}

describe("telemetry", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: string | undefined;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = process.env.SPAWN_TELEMETRY;
    fetchMock = mock((_url: string, _init?: RequestInit) => Promise.resolve(new Response("ok")));
    global.fetch = fetchMock;
    // Drain any leftover events from other test files by flushing
    process.emit("beforeExit", 0);
    // Reset the mock so stale flushes don't count
    fetchMock.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.SPAWN_TELEMETRY;
    } else {
      process.env.SPAWN_TELEMETRY = originalEnv;
    }
  });

  it("does nothing when SPAWN_TELEMETRY=0", () => {
    process.env.SPAWN_TELEMETRY = "0";
    tel.initTelemetry("1.0.0-test");
    tel.captureWarning("tel-test-disabled-warning");
    tel.captureError("log_error", new Error("tel-test-disabled-error"));
    process.emit("beforeExit", 0);
    // When disabled, no events should be queued, so no fetch calls for our marker
    const found = findWarningEvent(fetchMock, "tel-test-disabled-warning");
    expect(found).toBeUndefined();
  });

  it("sends cli_warning event via captureWarning", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureWarning("tel-test-warning-abc123");
    process.emit("beforeExit", 0);

    const warning = findWarningEvent(fetchMock, "tel-test-warning-abc123");
    expect(warning).toBeDefined();
    expect(warning?.properties?.message).toBe("tel-test-warning-abc123");
    expect(warning?.properties?.spawn_version).toBe("1.0.0-test");
    expect(warning?.properties?.distinct_id).toBeDefined();
    expect(warning?.properties?.$session_id).toBeDefined();
  });

  it("sends $exception event via captureError", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureError("log_error", new Error("tel-test-exc-something-broke"));
    process.emit("beforeExit", 0);

    const exception = findExceptionEvent(fetchMock, "tel-test-exc-something-broke");
    expect(exception).toBeDefined();
    const exList = exception?.properties?.$exception_list;
    expect(Array.isArray(exList)).toBe(true);
    if (!Array.isArray(exList)) {
      return;
    }
    expect(exList.length).toBe(1);
    expect(exList[0].type).toBe("log_error");
    expect(exList[0].value).toBe("tel-test-exc-something-broke");
    expect(exList[0].mechanism).toEqual({
      handled: true,
      type: "generic",
      synthetic: false,
    });
    expect(exList[0].stacktrace).toBeDefined();
  });

  it("scrubs API keys from error messages", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureWarning("tel-test-scrub-key: sk-or-v1-abc123def456ghi789jkl012mno345pqr678stu901vwx234");
    process.emit("beforeExit", 0);

    const warning = findWarningEvent(fetchMock, "tel-test-scrub-key");
    expect(warning).toBeDefined();
    const msg = warning?.properties?.message;
    expect(msg).not.toContain("sk-or-v1-");
    expect(msg).toContain("[REDACTED");
  });

  it("scrubs email addresses from error messages", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureWarning("tel-test-scrub-email: user@example.com not found");
    process.emit("beforeExit", 0);

    const warning = findWarningEvent(fetchMock, "tel-test-scrub-email");
    expect(warning).toBeDefined();
    const msg = warning?.properties?.message;
    expect(msg).not.toContain("user@example.com");
    expect(msg).toContain("[REDACTED_EMAIL]");
  });

  it("scrubs IP addresses from error messages", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureWarning("tel-test-scrub-ip: refused 192.168.1.100");
    process.emit("beforeExit", 0);

    const warning = findWarningEvent(fetchMock, "tel-test-scrub-ip");
    expect(warning).toBeDefined();
    const msg = warning?.properties?.message;
    expect(msg).not.toContain("192.168.1.100");
    expect(msg).toContain("[REDACTED_IP]");
  });

  it("sets context via setTelemetryContext", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.setTelemetryContext("agent", "claude");
    tel.setTelemetryContext("cloud", "hetzner");
    tel.captureWarning("tel-test-context-check");
    process.emit("beforeExit", 0);

    const warning = findWarningEvent(fetchMock, "tel-test-context-check");
    expect(warning).toBeDefined();
    expect(warning?.properties?.agent).toBe("claude");
    expect(warning?.properties?.cloud).toBe("hetzner");
  });

  it("handles non-Error values in captureError", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureError("log_error", "tel-test-string-error-value");
    process.emit("beforeExit", 0);

    const exception = findExceptionEvent(fetchMock, "tel-test-string-error-value");
    expect(exception).toBeDefined();
    const exList = exception?.properties?.$exception_list;
    expect(Array.isArray(exList)).toBe(true);
    if (!Array.isArray(exList)) {
      return;
    }
    expect(exList[0].value).toBe("tel-test-string-error-value");
    expect(exList[0].mechanism?.synthetic).toBe(true);
  });

  it("marks uncaught_exception as unhandled", () => {
    delete process.env.SPAWN_TELEMETRY;
    tel.initTelemetry("1.0.0-test");
    tel.captureError("uncaught_exception", new Error("tel-test-uncaught-crash"));
    process.emit("beforeExit", 0);

    const exception = findExceptionEvent(fetchMock, "tel-test-uncaught-crash");
    expect(exception).toBeDefined();
    const exList = exception?.properties?.$exception_list;
    expect(Array.isArray(exList)).toBe(true);
    if (!Array.isArray(exList)) {
      return;
    }
    expect(exList[0].mechanism?.handled).toBe(false);
    expect(exList[0].mechanism?.type).toBe("onuncaughtexception");
  });
});
