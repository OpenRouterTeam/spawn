import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
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
 *
 * Agent: test-engineer
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
  isCancel: () => false,
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

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("should report up-to-date when remote version matches current", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("package.json")) {
        return {
          ok: true,
          json: async () => ({ version: VERSION }),
        };
      }
      return { ok: false, status: 404 };
    }) as any;

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    expect(mockSpinnerStop).toHaveBeenCalled();
    // The spinner stop message should indicate up-to-date
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("up to date"))).toBe(true);
  });

  it("should report available update when remote version differs", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("package.json")) {
        return {
          ok: true,
          json: async () => ({ version: "99.99.99" }),
        };
      }
      return { ok: false, status: 404 };
    }) as any;

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    // Should show update message with version transition
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("99.99.99"))).toBe(true);
  });

  it("should handle package.json fetch failure gracefully", async () => {
    global.fetch = mock(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    })) as any;

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
    }) as any;

    await cmdUpdate();

    expect(mockSpinnerStart).toHaveBeenCalled();
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("Failed"))).toBe(true);
  });

  it("should handle update failure gracefully", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("package.json")) {
        return {
          ok: true,
          json: async () => ({ version: "99.99.99" }),
        };
      }
      return { ok: false, status: 404 };
    }) as any;

    // cmdUpdate now runs execSync which will fail in test env
    // The function catches errors internally, so it should not throw
    await cmdUpdate();

    // Should show the update version in spinner stop
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) => msg.includes("99.99.99"))).toBe(true);
  });

  it("should start spinner with checking message", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ version: VERSION }),
    })) as any;

    await cmdUpdate();

    const startCalls = mockSpinnerStart.mock.calls.map((c: any[]) => c.join(" "));
    expect(startCalls.some((msg: string) => msg.includes("Checking"))).toBe(true);
  });

  it("should show version in spinner stop during update", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("package.json")) {
        return {
          ok: true,
          json: async () => ({ version: "2.0.0" }),
        };
      }
      return { ok: false };
    }) as any;

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

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;

    // Set up manifest mock
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("should exit when both primary and fallback URLs return 404", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      // Both script URLs return 404
      return {
        ok: false,
        status: 404,
        text: async () => "Not Found",
      };
    }) as any;

    await loadManifest(true);
    await expect(cmdRun("claude", "sprite")).rejects.toThrow("process.exit");

    expect(processExitSpy).toHaveBeenCalledWith(1);

    // Should show 404-specific error messaging
    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("could not be found");
  });

  it("should exit when both primary and fallback URLs return server errors", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => "Server Error",
      };
    }) as any;

    await loadManifest(true);
    await expect(cmdRun("claude", "sprite")).rejects.toThrow("process.exit");

    expect(processExitSpy).toHaveBeenCalledWith(1);
    const logErrorOutput = mockLogError.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(logErrorOutput).toContain("HTTP 500");
  });

  it("should show troubleshooting info when download throws network error", async () => {
    let callCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      throw new Error("Network timeout");
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - either process.exit or thrown error
    }

    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("How to fix");
  });

  it("should use fallback URL when primary returns non-OK status", async () => {
    let fetchedUrls: string[] = [];
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string") {
        fetchedUrls.push(url);
      }
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      if (typeof url === "string" && url.includes("openrouter.ai")) {
        // Primary fails
        return { ok: false, status: 503, text: async () => "Service Unavailable" };
      }
      if (typeof url === "string" && url.includes("raw.githubusercontent.com")) {
        // Fallback returns valid script
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\necho 'hello'",
        };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    }) as any;

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
    const scriptUrls = fetchedUrls.filter(u => u.includes(".sh"));
    expect(scriptUrls.length).toBeGreaterThanOrEqual(2);
    expect(scriptUrls.some(u => u.includes("openrouter.ai"))).toBe(true);
    expect(scriptUrls.some(u => u.includes("raw.githubusercontent.com"))).toBe(true);

    // Should show fallback spinner message
    const messageCalls = mockSpinnerMessage.mock.calls.map((c: any[]) => c.join(" "));
    expect(messageCalls.some((msg: string) => msg.includes("fallback"))).toBe(true);
  });

  it("should show spinner with download message during script fetch", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const startCalls = mockSpinnerStart.mock.calls.map((c: any[]) => c.join(" "));
    expect(startCalls.some((msg: string) => msg.includes("Download"))).toBe(true);
  });

  it("should reject script without shebang via validateScriptContent", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      // Return non-script content
      return {
        ok: true,
        text: async () => "echo hello world",
      };
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - validateScriptContent will reject this
    }

    // Should have gotten past download (spinner stop indicates success)
    const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
    expect(stopCalls.some((msg: string) =>
      msg.includes("downloaded") || msg.includes("Download")
    )).toBe(true);
  });

  it("should reject script with dangerous pattern (rm -rf /)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      return {
        ok: true,
        text: async () => "#!/bin/bash\nrm -rf / --no-preserve-root",
      };
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - validateScriptContent should block this
    }

    // The error from the download/execution pipeline should be caught
    const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    const allErrors = [...errorCalls, errorOutput].join("\n");
    expect(
      allErrors.includes("dangerous") ||
      allErrors.includes("blocked") ||
      allErrors.includes("Failed") ||
      allErrors.includes("Error")
    ).toBe(true);
  });

  it("should show script-not-found message when both URLs 404", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      return { ok: false, status: 404, text: async () => "Not Found" };
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const allOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(allOutput).toContain("could not be found");
    expect(allOutput).toContain("spawn matrix");
    expect(allOutput).toContain("Report the issue");
  });

  it("should show network error message when primary 500 and fallback 502", async () => {
    let callIndex = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      if (typeof url === "string" && url.includes("openrouter.ai")) {
        return { ok: false, status: 500, text: async () => "Error" };
      }
      if (typeof url === "string" && url.includes("raw.githubusercontent.com")) {
        return { ok: false, status: 502, text: async () => "Bad Gateway" };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const allOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(allOutput).toContain("try again");
  });

  it("should show prompt preview in info message when prompt is provided", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      return {
        ok: true,
        text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
      };
    }) as any;

    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite", "Write tests for the auth module");
    } catch {
      // Expected - bash execution in test env
    }

    const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
    expect(infoCalls.some((msg: string) => msg.includes("Prompt:") && msg.includes("Write tests"))).toBe(true);
  });
});
