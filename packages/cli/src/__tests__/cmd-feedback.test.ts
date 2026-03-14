/**
 * cmd-feedback.test.ts — Tests for the `spawn feedback` command.
 *
 * Verifies:
 * - Empty message exits with error
 * - Successful PostHog submission prints thank-you
 * - PostHog non-2xx response exits with error
 * - Fetch network failure exits with error
 * - Correct PostHog payload structure (token, survey ID, event shape)
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { isString } from "../shared/type-guards";
import { createConsoleMocks, restoreMocks } from "./test-helpers";

// ── Import module under test ──────────────────────────────────────────────────

const { cmdFeedback } = await import("../commands/feedback.js");

// ── Test Setup ────────────────────────────────────────────────────────────────

describe("cmdFeedback", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    originalFetch = global.fetch;
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    restoreMocks(consoleMocks.log, consoleMocks.error, exitSpy);
    global.fetch = originalFetch;
  });

  it("exits with error when no message is provided", async () => {
    await expect(cmdFeedback([])).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleMocks.error).toHaveBeenCalled();
    const errorOutput = consoleMocks.error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(errorOutput).toContain("Please provide your feedback message");
  });

  it("exits with error when message is only whitespace", async () => {
    await expect(
      cmdFeedback([
        "  ",
        "  ",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("sends feedback to PostHog and prints success", async () => {
    global.fetch = mock(() => Promise.resolve(new Response("ok")));

    await cmdFeedback([
      "Great",
      "tool!",
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const logOutput = consoleMocks.log.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logOutput).toContain("Thanks for your feedback");
  });

  it("sends correct PostHog payload shape", async () => {
    let capturedBody: string | undefined;
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = isString(init?.body) ? init.body : undefined;
      return Promise.resolve(new Response("ok"));
    });

    await cmdFeedback([
      "test message",
    ]);

    expect(capturedBody).toBeDefined();
    const payload = JSON.parse(capturedBody ?? "{}");
    expect(payload.token).toBeString();
    expect(payload.distinct_id).toBe("anon");
    expect(payload.event).toBe("survey sent");
    expect(payload.properties.$survey_response).toBe("test message");
    expect(payload.properties.$survey_completed).toBe(true);
    expect(payload.properties.source).toBe("cli");
  });

  it("joins multiple args into a single message", async () => {
    let capturedBody: string | undefined;
    global.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = isString(init?.body) ? init.body : undefined;
      return Promise.resolve(new Response("ok"));
    });

    await cmdFeedback([
      "hello",
      "world",
      "test",
    ]);

    const payload = JSON.parse(capturedBody ?? "{}");
    expect(payload.properties.$survey_response).toBe("hello world test");
  });

  it("exits with error when PostHog returns non-2xx", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response("Server Error", {
          status: 500,
        }),
      ),
    );

    await expect(
      cmdFeedback([
        "some feedback",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = consoleMocks.error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(errorOutput).toContain("Failed to send feedback");
  });

  it("exits with error when fetch throws (network failure)", async () => {
    global.fetch = mock(() => Promise.reject(new Error("Network unreachable")));

    await expect(
      cmdFeedback([
        "some feedback",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errorOutput = consoleMocks.error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(errorOutput).toContain("Failed to send feedback");
  });
});
