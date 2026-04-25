/**
 * telemetry.test.ts — Tests for shared/telemetry.ts
 *
 * Verifies:
 * - PII scrubbing (API keys, emails, IPs, tokens, home paths)
 * - Stack frame parsing for $exception events
 * - PostHog batch payload structure (distinct_id, event shape)
 * - Telemetry disabled when SPAWN_TELEMETRY=0
 * - captureWarning produces cli_warning events
 * - captureError produces $exception events with correct structure
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isString } from "@openrouter/spawn-shared";
import * as v from "valibot";

// ── Schemas for validating PostHog payloads ─────────────────────────────────

const MechanismSchema = v.object({
  handled: v.boolean(),
  type: v.string(),
  synthetic: v.boolean(),
});

const StackFrameSchema = v.object({
  platform: v.string(),
  function: v.string(),
  filename: v.string(),
  in_app: v.boolean(),
  lineno: v.optional(v.number()),
  colno: v.optional(v.number()),
});

const ExceptionEntrySchema = v.object({
  type: v.string(),
  value: v.string(),
  mechanism: MechanismSchema,
  stacktrace: v.optional(
    v.object({
      type: v.string(),
      frames: v.array(StackFrameSchema),
    }),
  ),
});

const BatchEventSchema = v.object({
  event: v.string(),
  timestamp: v.string(),
  properties: v.record(v.string(), v.unknown()),
});

const BatchBodySchema = v.object({
  api_key: v.string(),
  batch: v.array(BatchEventSchema),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the JSON body from the most recent fetch call. */
function getLastBatchBody(fetchMock: ReturnType<typeof mock>): v.InferOutput<typeof BatchBodySchema> | null {
  const calls = fetchMock.mock.calls;
  if (calls.length === 0) {
    return null;
  }
  const lastCall = calls[calls.length - 1];
  const opts = lastCall[1];
  if (typeof opts !== "object" || opts === null) {
    return null;
  }
  const rec = v.safeParse(
    v.object({
      body: v.string(),
    }),
    opts,
  );
  if (!rec.success) {
    return null;
  }
  const parsed = v.safeParse(BatchBodySchema, JSON.parse(rec.output.body));
  if (!parsed.success) {
    return null;
  }
  return parsed.output;
}

/** Extract the first $exception entry from a batch body. */
function getFirstExceptionEntry(
  body: v.InferOutput<typeof BatchBodySchema>,
): v.InferOutput<typeof ExceptionEntrySchema> | null {
  const evt = body.batch.find((e) => e.event === "$exception");
  if (!evt) {
    return null;
  }
  const list = evt.properties.$exception_list;
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  const parsed = v.safeParse(ExceptionEntrySchema, list[0]);
  if (!parsed.success) {
    return null;
  }
  return parsed.output;
}

describe("telemetry", () => {
  let originalFetch: typeof global.fetch;
  let originalTelemetry: string | undefined;
  let originalBunEnv: string | undefined;
  let originalNodeEnv: string | undefined;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalTelemetry = process.env.SPAWN_TELEMETRY;
    originalBunEnv = process.env.BUN_ENV;
    originalNodeEnv = process.env.NODE_ENV;
    // Enable telemetry — these tests need initTelemetry() to actually flip
    // _enabled to true so they can assert on the sent payloads. Clearing
    // BUN_ENV/NODE_ENV lets the test-env guard in initTelemetry pass.
    delete process.env.SPAWN_TELEMETRY;
    delete process.env.BUN_ENV;
    delete process.env.NODE_ENV;
    // Mock fetch to capture PostHog payloads
    fetchMock = mock(() => Promise.resolve(new Response("ok")));
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalTelemetry !== undefined) {
      process.env.SPAWN_TELEMETRY = originalTelemetry;
    } else {
      delete process.env.SPAWN_TELEMETRY;
    }
    if (originalBunEnv !== undefined) {
      process.env.BUN_ENV = originalBunEnv;
    } else {
      delete process.env.BUN_ENV;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  /** Flush telemetry and wait for async send. */
  async function flushAndWait(): Promise<void> {
    process.emit("beforeExit", 0);
    await new Promise((r) => setTimeout(r, 50));
  }

  /** Drain any stale events accumulated by the singleton module from other tests. */
  async function drainStaleEvents(): Promise<void> {
    await flushAndWait();
    fetchMock.mockClear();
  }

  describe("scrubbing", () => {
    it("redacts OpenRouter API keys from error messages", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("Failed with key sk-or-v1-abc123def456ghi789jkl012mno345"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).not.toContain("sk-or-v1-");
      expect(entry?.value).toContain("[REDACTED_KEY]");
    });

    it("redacts Anthropic API keys", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("key: sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXX"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).toContain("[REDACTED_KEY]");
      expect(entry?.value).not.toContain("sk-ant-api03-");
    });

    it("redacts email addresses", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("Contact user@example.com for help"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).toContain("[REDACTED_EMAIL]");
      expect(entry?.value).not.toContain("user@example.com");
    });

    it("redacts IPv4 addresses", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("Connection to 192.168.1.100 refused"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).toContain("[REDACTED_IP]");
      expect(entry?.value).not.toContain("192.168.1.100");
    });

    it("redacts home directory paths", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("File not found: /home/johndoe/.config/spawn"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).toContain("~/[USER]");
      expect(entry?.value).not.toContain("/home/johndoe");
    });

    it("redacts GitHub tokens", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("Auth failed with ghp_1234567890abcdefghij"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).toContain("[REDACTED_GITHUB_TOKEN]");
      expect(entry?.value).not.toContain("ghp_");
    });

    it("redacts Bearer tokens", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", new Error("Header: Bearer eyJhbGciOiJIUz.truncated"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.value).toContain("Bearer [REDACTED]");
    });
  });

  describe("captureWarning", () => {
    it("sends a cli_warning event with scrubbed message", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureWarning("Slow connection to 10.0.0.1");
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const warningEvt = body?.batch.find((e) => e.event === "cli_warning");
      expect(warningEvt).toBeDefined();
      expect(String(warningEvt?.properties.message ?? "")).toContain("[REDACTED_IP]");
      expect(String(warningEvt?.properties.message ?? "")).not.toContain("10.0.0.1");
    });
  });

  describe("captureError", () => {
    it("produces $exception event with mechanism info", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("log_error", new Error("something broke"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.type).toBe("log_error");
      expect(entry?.value).toBe("something broke");
      expect(entry?.mechanism.handled).toBe(true);
      expect(entry?.mechanism.type).toBe("generic");
      expect(entry?.mechanism.synthetic).toBe(false);
    });

    it("marks uncaught_exception as unhandled with correct mechanism type", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("uncaught_exception", new Error("crash"));
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.mechanism.handled).toBe(false);
      expect(entry?.mechanism.type).toBe("onuncaughtexception");
    });

    it("marks non-Error values as synthetic", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureError("test_error", "plain string error");
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.mechanism.synthetic).toBe(true);
      expect(entry?.value).toBe("plain string error");
    });

    it("includes stack frames when Error has a stack", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");

      await drainStaleEvents();

      const err = new Error("test");
      mod.captureError("test_error", err);
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const entry = body ? getFirstExceptionEntry(body) : null;
      expect(entry).not.toBeNull();
      expect(entry?.stacktrace).toBeDefined();
      expect(entry?.stacktrace?.type).toBe("raw");
      expect(entry?.stacktrace?.frames.length).toBeGreaterThan(0);

      const frame = entry?.stacktrace?.frames[0];
      expect(frame?.platform).toBe("node:javascript");
      expect(typeof frame?.filename).toBe("string");
      expect(typeof frame?.function).toBe("string");
      expect(typeof frame?.in_app).toBe("boolean");
    });
  });

  describe("PostHog payload structure", () => {
    it("includes api_key and distinct_id in batch", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureWarning("test");
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();
      expect(body?.api_key.length).toBeGreaterThan(0);

      for (const entry of body?.batch ?? []) {
        expect(typeof entry.properties.distinct_id).toBe("string");
        expect(typeof entry.timestamp).toBe("string");
      }
    });

    it("includes spawn_version and session context", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("1.2.3-test");
      mod.setTelemetryContext("agent", "claude");
      mod.setTelemetryContext("cloud", "hetzner");
      await drainStaleEvents();

      mod.captureWarning("test");
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();

      const props = body?.batch[0]?.properties;
      expect(props?.spawn_version).toBe("1.2.3-test");
      expect(props?.agent).toBe("claude");
      expect(props?.cloud).toBe("hetzner");
      expect(typeof props?.$session_id).toBe("string");
    });
  });

  describe("disabled telemetry", () => {
    it("does not send events when SPAWN_TELEMETRY=0", async () => {
      process.env.SPAWN_TELEMETRY = "0";

      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureWarning("should not send");
      mod.captureError("test", new Error("should not send"));
      mod.captureEvent("should_not_send", {
        spawn_id: "abc",
      });
      await flushAndWait();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send events when BUN_ENV=test (CI guard)", async () => {
      process.env.BUN_ENV = "test";

      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureEvent("funnel_started", {
        agent: "claude",
      });
      mod.captureError("test", new Error("ci"));
      await flushAndWait();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send events when NODE_ENV=test (CI guard)", async () => {
      process.env.NODE_ENV = "test";

      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("0.0.0-test");
      await drainStaleEvents();

      mod.captureEvent("funnel_started", {
        agent: "claude",
      });
      await flushAndWait();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("captureEvent", () => {
    it("emits a batched event with the given name and properties", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("1.2.3-test");
      await drainStaleEvents();

      mod.captureEvent("funnel_started", {
        fast_mode: true,
        elapsed_ms: 0,
      });
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      expect(body).not.toBeNull();
      const evt = body?.batch[0];
      expect(evt?.event).toBe("funnel_started");
      expect(evt?.properties.fast_mode).toBe(true);
      expect(evt?.properties.elapsed_ms).toBe(0);
      expect(evt?.properties.spawn_version).toBe("1.2.3-test");
    });

    it("scrubs string property values but leaves non-strings alone", async () => {
      const mod = await import("../shared/telemetry.js");
      mod.initTelemetry("1.2.3-test");
      await drainStaleEvents();

      mod.captureEvent("spawn_connected", {
        spawn_id: "abc123",
        note: "contact me at alice@example.com about sk-or-v1-1234567890abcdef",
        connect_count: 5,
        lifetime_hours: 3.5,
      });
      await flushAndWait();

      const body = getLastBatchBody(fetchMock);
      const props = body?.batch[0]?.properties;
      // Non-string values pass through untouched.
      expect(props?.spawn_id).toBe("abc123");
      expect(props?.connect_count).toBe(5);
      expect(props?.lifetime_hours).toBe(3.5);
      // String values get scrubbed.
      const rawNote = props?.note;
      const note = isString(rawNote) ? rawNote : "";
      expect(note).toContain("[REDACTED_EMAIL]");
      expect(note).not.toContain("alice@example.com");
      expect(note).toContain("[REDACTED_KEY]");
      expect(note).not.toContain("sk-or-v1-1234567890abcdef");
    });
  });
});
