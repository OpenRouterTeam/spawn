import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import { isString } from "@openrouter/spawn-shared";
import pkg from "../../package.json" with { type: "json" };
const VERSION = pkg.version;

/**
 * Tests for cmdUpdate and script download/execution paths in commands.ts.
 *
 * These functions have zero test coverage in the existing test suite:
 * - cmdUpdate: checks for CLI updates by fetching remote package.json
 * - execScript: downloads and runs a spawn script with fallback
 * - downloadScriptWithFallback: tries primary URL then GitHub raw fallback
 * - reportDownloadFailure: formats error messages for failed downloads
 * - runBash: validates and executes downloaded script content
 *
 * The tests mock @clack/prompts, global.fetch, and process.exit to
 * exercise the actual exported functions without side effects.
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});
const mockSpinnerMessage = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mockSpinnerMessage,
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    warn: mock(() => {}),
    error: mockLogError,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

// Mock node:child_process to prevent real subprocess calls in tests:
// - execSync: used by performUpdate() to run curl|bash install — without this mock,
//   "should handle update failure gracefully" downloads the real install script from
//   the network, causing a 58s timeout under full-suite concurrency (CLAUDE.md violation).
// - spawnSync: used by spawnBash() to run downloaded scripts — returns exit code 0
//   so callers see a successful execution.
mock.module("node:child_process", () => ({
  execSync: mock(() => {}),
  execFileSync: mock(() => {}),
  spawnSync: mock(() => ({
    status: 0,
    signal: null,
    error: null,
  })),
}));

// Import commands after mock setup
const { cmdUpdate, cmdRun } = await import("../commands.js");

describe("cmdUpdate", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();

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
      if (isString(url) && url.includes("package.json")) {
        return new Response(
          JSON.stringify({
            version: VERSION,
          }),
        );
      }
      return new Response("Not Found", {
        status: 404,
      });
    });

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    expect(mockSpinnerStop).toHaveBeenCalled();
    // The spinner stop message should indicate up-to-date
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("up to date"))).toBe(true);
  });

  it("should report available update when remote version differs", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("package.json")) {
        return new Response(
          JSON.stringify({
            version: "99.99.99",
          }),
        );
      }
      return new Response("Not Found", {
        status: 404,
      });
    });

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    // Should show update message with version transition
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("99.99.99"))).toBe(true);
  });

  it("should handle package.json fetch failure gracefully", async () => {
    global.fetch = mock(
      async () =>
        new Response("Internal Server Error", {
          status: 500,
        }),
    );

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    // Should show failed message
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("Failed"))).toBe(true);
    // Should output error details
    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("Error:");
  });

  it("should handle network error gracefully", async () => {
    global.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    });

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("Failed"))).toBe(true);
  });

  it("should handle update failure gracefully", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("package.json")) {
        return new Response(
          JSON.stringify({
            version: "99.99.99",
          }),
        );
      }
      return new Response("Not Found", {
        status: 404,
      });
    });

    // cmdUpdate now runs execSync which will fail in test env
    // The function catches errors internally, so it should not throw
    await cmdUpdate();

    // Should show the update version in spinner stop
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
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

    await cmdUpdate();

    const startCalls = mockSpinnerStart.mock.calls.map((c: any[]) => c.join(" "));
    expect(startCalls.some((msg: string) => msg.includes("Checking"))).toBe(true);
  });

  it("should show version in spinner stop during update", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("package.json")) {
        return new Response(
          JSON.stringify({
            version: "2.0.0",
          }),
        );
      }
      return new Response("Error", {
        status: 500,
      });
    });

    await cmdUpdate();

    // cmdUpdate now uses s.stop() with version info instead of s.message()
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("2.0.0"))).toBe(true);
  });
});

describe("Script download and execution", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;

    // Set up manifest mock
    global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("should exit when both primary and fallback URLs return 404", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      // Both script URLs return 404
      return new Response("Not Found", {
        status: 404,
      });
    });

    await loadManifest(true);
    await expect(cmdRun("claude", "sprite")).rejects.toThrow("process.exit");

    expect(processExitSpy).toHaveBeenCalledWith(1);

    // Should show 404-specific error messaging
    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("doesn't exist");
  });

  it("should exit when both primary and fallback URLs return server errors", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      return new Response("Server Error", {
        status: 500,
      });
    });

    await loadManifest(true);
    await expect(cmdRun("claude", "sprite")).rejects.toThrow("process.exit");

    expect(processExitSpy).toHaveBeenCalledWith(1);
    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("HTTP 500");
  });

  it("should show troubleshooting info when download throws network error", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      throw new Error("Network timeout");
    });

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - either process.exit or thrown error
    }

    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("Next steps");
  });

  it("should use fallback URL when primary returns non-OK status", async () => {
    const fetchedUrls: string[] = [];
    global.fetch = mock(async (url: string) => {
      if (isString(url)) {
        fetchedUrls.push(url);
      }
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      if (isString(url) && url.includes("openrouter.ai")) {
        // Primary fails
        return new Response("Service Unavailable", {
          status: 503,
        });
      }
      if (isString(url) && url.includes("raw.githubusercontent.com")) {
        // Fallback returns valid script
        return new Response("#!/bin/bash\nset -eo pipefail\necho 'hello'");
      }
      return new Response("Not found", {
        status: 404,
      });
    });

    await loadManifest(true);

    // This will download the script successfully via fallback and attempt to run it.
    // The bash execution will fail since it's a test env, but we can verify
    // the download path worked by checking spinner messages.
    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - bash execution or process.exit
    }

    // Verify both URLs were attempted
    const scriptUrls = fetchedUrls.filter((u) => u.includes(".sh"));
    expect(scriptUrls.length).toBeGreaterThanOrEqual(2);
    expect(scriptUrls.some((u) => u.includes("openrouter.ai"))).toBe(true);
    expect(scriptUrls.some((u) => u.includes("raw.githubusercontent.com"))).toBe(true);

    // Should show fallback spinner message
    const messageCalls = mockSpinnerMessage.mock.calls.map((c: any[]) => c.join(" "));
    expect(messageCalls.some((msg: string) => msg.includes("fallback"))).toBe(true);
  });

  it("should show spinner with download message during script fetch", async () => {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      return new Response("Not found", {
        status: 404,
      });
    });

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const startCalls = mockSpinnerStart.mock.calls.map((c: any[]) => c.join(" "));
    expect(startCalls.some((msg: string) => msg.includes("Download"))).toBe(true);
  });

  it("should show network error message when primary 500 and fallback 502", async () => {
    const callIndex = 0;
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      if (isString(url) && url.includes("openrouter.ai")) {
        return new Response("Error", {
          status: 500,
        });
      }
      if (isString(url) && url.includes("raw.githubusercontent.com")) {
        return new Response("Bad Gateway", {
          status: 502,
        });
      }
      return new Response("Not found", {
        status: 404,
      });
    });

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const allOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(allOutput).toContain("try again");
  });

  it("should pass SPAWN_PROMPT and SPAWN_MODE env vars with prompt", async () => {
    // We can verify the launch step message includes "with prompt"
    // when a valid prompt is provided
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
    });

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite", "Write tests for the auth module");
    } catch {
      // Expected - bash execution in test env
    }

    const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
    expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(true);
  });
});
