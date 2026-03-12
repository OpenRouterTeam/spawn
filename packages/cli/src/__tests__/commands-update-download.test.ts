import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { isString } from "../shared/type-guards";
import { createConsoleMocks, mockClackPrompts, restoreMocks } from "./test-helpers";

const VERSION = pkg.version;

/**
 * Tests for cmdUpdate (commands/update.ts).
 *
 * Uses dependency injection (UpdateOptions.runUpdate) instead of mock.module
 * for node:child_process to avoid process-global mock pollution.
 */

const { spinnerStart: mockSpinnerStart, spinnerStop: mockSpinnerStop } = mockClackPrompts();

// ── Import commands directly (no mock.module needed) ──────────────────────
import { cmdUpdate } from "../commands/index.js";

/** No-op runUpdate to prevent real subprocess calls in tests. */
const mockRunUpdate = mock(() => {});

describe("cmdUpdate", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockRunUpdate.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("should report up-to-date when remote version matches current", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("/version")) {
        return new Response(`${VERSION}\n`);
      }
      return new Response("Not Found", {
        status: 404,
      });
    });

    await cmdUpdate({
      runUpdate: mockRunUpdate,
    });

    expect(mockSpinnerStart).toHaveBeenCalled();
    expect(mockSpinnerStop).toHaveBeenCalled();
    // The spinner stop message should indicate up-to-date
    const stopCalls = mockSpinnerStop.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("up to date"))).toBe(true);
  });

  it("should report available update when remote version differs", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("/version")) {
        return new Response("99.99.99\n");
      }
      return new Response("Not Found", {
        status: 404,
      });
    });

    await cmdUpdate({
      runUpdate: mockRunUpdate,
    });

    expect(mockSpinnerStart).toHaveBeenCalled();
    // Should show update message with version transition
    const stopCalls = mockSpinnerStop.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("99.99.99"))).toBe(true);
  });

  it("should handle package.json fetch failure gracefully", async () => {
    global.fetch = mock(
      async () =>
        new Response("Internal Server Error", {
          status: 500,
        }),
    );

    await cmdUpdate({
      runUpdate: mockRunUpdate,
    });

    expect(mockSpinnerStart).toHaveBeenCalled();
    // Should show failed message
    const stopCalls = mockSpinnerStop.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("Failed"))).toBe(true);
    // Should output error details
    const errorOutput = consoleMocks.error.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("Error:");
  });

  it("should handle network error gracefully", async () => {
    global.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    });

    await cmdUpdate({
      runUpdate: mockRunUpdate,
    });

    expect(mockSpinnerStart).toHaveBeenCalled();
    const stopCalls = mockSpinnerStop.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("Failed"))).toBe(true);
  });

  it("should handle update failure gracefully", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("/version")) {
        return new Response("99.99.99\n");
      }
      return new Response("Not Found", {
        status: 404,
      });
    });

    // Mock runUpdate that throws to simulate failure
    const failingRunUpdate = mock(() => {
      throw new Error("curl failed");
    });

    await cmdUpdate({
      runUpdate: failingRunUpdate,
    });

    // Should show the update version in spinner stop
    const stopCalls = mockSpinnerStop.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("99.99.99"))).toBe(true);
  });

  it("should start spinner with checking message", async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            version: VERSION,
          }),
        ),
    );

    await cmdUpdate({
      runUpdate: mockRunUpdate,
    });

    const startCalls = mockSpinnerStart.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(startCalls.some((msg: string) => msg.includes("Checking"))).toBe(true);
  });

  it("should show version in spinner stop during update", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("/version")) {
        return new Response("2.0.0\n");
      }
      return new Response("Error", {
        status: 500,
      });
    });

    await cmdUpdate({
      runUpdate: mockRunUpdate,
    });

    // cmdUpdate now uses s.stop() with version info instead of s.message()
    const stopCalls = mockSpinnerStop.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("2.0.0"))).toBe(true);
  });
});
