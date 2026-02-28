import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import { isString } from "@openrouter/spawn-shared";

/**
 * Tests for the download fallback pipeline and script failure reporting
 * through real exported code paths in commands.ts.
 *
 * - downloadScriptWithFallback: primary URL succeeds (real code path through cmdRun)
 * - downloadScriptWithFallback: primary fails, fallback succeeds (real cmdRun)
 * - downloadScriptWithFallback: both fail with 404 (reportDownloadFailure 404+404 path)
 * - downloadScriptWithFallback: primary 500, fallback 500 (server error path)
 * - downloadScriptWithFallback: primary 404, fallback 500 (mixed error path)
 * - downloadScriptWithFallback: network error (reportDownloadError path)
 * - reportScriptFailure: exit code extraction from error message
 * - reportScriptFailure: specific guidance for codes 1, 2, 126, 127, 130, 137, 255
 * - reportScriptFailure: unknown exit code (default guidance)
 * - execScript: validateScriptContent rejection of bad scripts
 * - execScript: interrupted script (code 130) handling
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
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
    error: mockLogError,
    warn: mockLogWarn,
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

// Import after mock setup
const { cmdRun } = await import("../commands.js");

describe("Download and Failure Pipeline", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  /** Set up fetch to return manifest from manifest URLs and custom responses for script URLs */
  function setupFetch(scriptHandler: (url: string) => Promise<Response>) {
    global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("manifest.json")) {
        return new Response(JSON.stringify(mockManifest));
      }
      return scriptHandler(urlStr);
    });
    return loadManifest(true);
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
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

  // ── downloadScriptWithFallback: primary URL succeeds ──────────────

  describe("download - primary URL succeeds", () => {
    it("should download script from primary URL and attempt execution", async () => {
      await setupFetch(async (url) => {
        // Primary URL succeeds with a valid-looking script
        if (url.includes("openrouter.ai")) {
          return new Response("#!/bin/bash\nexit 0");
        }
        throw new Error("Should not reach fallback");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Will throw from bash execution or process.exit
      }

      // Spinner should show "Downloading" and then "Script downloaded"
      expect(mockSpinnerStart).toHaveBeenCalled();
      const startCalls = mockSpinnerStart.mock.calls.map((c: any[]) => c.join(" "));
      expect(startCalls.some((msg: string) => msg.includes("Downloading"))).toBe(true);

      // Stop should show "Script downloaded" (without "(fallback)")
      const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
      expect(stopCalls.some((msg: string) => msg.includes("Script downloaded"))).toBe(true);
    });

    it("should not try fallback when primary succeeds", async () => {
      let fallbackCalled = false;
      await setupFetch(async (url) => {
        if (url.includes("openrouter.ai")) {
          return new Response("#!/bin/bash\nexit 0");
        }
        fallbackCalled = true;
        return new Response("#!/bin/bash\nexit 0");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      expect(fallbackCalled).toBe(false);
    });
  });

  // ── downloadScriptWithFallback: primary fails, fallback succeeds ──

  describe("download - primary fails, fallback succeeds", () => {
    it("should fall back to GitHub raw URL when primary returns 404", async () => {
      await setupFetch(async (url) => {
        if (url.includes("openrouter.ai")) {
          return new Response("Not Found", {
            status: 404,
          });
        }
        // GitHub raw fallback succeeds
        if (url.includes("raw.githubusercontent.com")) {
          return new Response("#!/bin/bash\nexit 0");
        }
        return new Response("Server Error", {
          status: 500,
        });
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected from execution
      }

      // Spinner should have shown "Trying fallback source..."
      const msgCalls = mockSpinnerMessage.mock.calls.map((c: any[]) => c.join(" "));
      expect(msgCalls.some((msg: string) => msg.includes("fallback"))).toBe(true);

      // Stop should show "Script downloaded (fallback)"
      const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
      expect(stopCalls.some((msg: string) => msg.includes("fallback"))).toBe(true);
    });

    it("should fall back to GitHub raw URL when primary returns 500", async () => {
      await setupFetch(async (url) => {
        if (url.includes("openrouter.ai")) {
          return new Response("Server Error", {
            status: 500,
          });
        }
        if (url.includes("raw.githubusercontent.com")) {
          return new Response("#!/bin/bash\nexit 0");
        }
        return new Response("Server Error", {
          status: 500,
        });
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected from execution
      }

      // Should still succeed with fallback
      const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
      expect(stopCalls.some((msg: string) => msg.includes("fallback"))).toBe(true);
    });
  });

  // ── downloadScriptWithFallback: both fail ─────────────────────────

  describe("download - both URLs fail", () => {
    it("should show 'script not found' when both return 404", async () => {
      await setupFetch(async () => {
        return new Response("Not Found", {
          status: 404,
        });
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected: process.exit(1) from reportDownloadFailure
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);

      // reportDownloadFailure should log specific 404 error
      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("doesn't exist");
    });

    it("should suggest verifying the combination when both return 404", async () => {
      await setupFetch(
        async () =>
          new Response("Not Found", {
            status: 404,
          }),
      );

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("spawn matrix");
    });

    it("should suggest reporting the issue when both return 404", async () => {
      await setupFetch(
        async () =>
          new Response("Not Found", {
            status: 404,
          }),
      );

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Report it");
    });

    it("should show server error message when both return 500", async () => {
      await setupFetch(
        async () =>
          new Response("Server Error", {
            status: 500,
          }),
      );

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("HTTP 500");
    });

    it("should mention temporary server issues on 500 errors", async () => {
      await setupFetch(
        async () =>
          new Response("Server Error", {
            status: 500,
          }),
      );

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("temporarily unavailable");
    });

    it("should show mixed error for primary 404 and fallback 500", async () => {
      let callCount = 0;
      await setupFetch(async (url) => {
        callCount++;
        if (url.includes("openrouter.ai")) {
          return new Response("Not Found", {
            status: 404,
          });
        }
        return new Response("Server Error", {
          status: 500,
        });
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      // Should show HTTP error codes in console output (not the "script not found" path)
      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("HTTP 404");
      // 500 from fallback should mention server issues
      expect(errorOutput).toContain("temporarily unavailable");
    });
  });

  // ── downloadScriptWithFallback: network error (fetch throws) ──────

  describe("download - network error", () => {
    it("should call reportDownloadError when fetch throws", async () => {
      await setupFetch(async () => {
        throw new Error("DNS resolution failed");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("DNS resolution failed");
    });

    it("should show troubleshooting steps on network error", async () => {
      await setupFetch(async () => {
        throw new Error("Network timeout");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Next steps");
      expect(errorOutput).toContain("internet connection");
    });

    it("should suggest spawn list for verification on network error", async () => {
      await setupFetch(async () => {
        throw new Error("Connection refused");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Firewall or proxy");
    });

    it("should show the GitHub raw URL for manual access on network error", async () => {
      await setupFetch(async () => {
        throw new Error("ETIMEDOUT");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("raw.githubusercontent.com");
    });
  });

  // ── execScript: validateScriptContent rejection ───────────────────

  describe("execScript - script content validation", () => {
    it("should reject script missing shebang line", async () => {
      await setupFetch(async (url) => {
        if (url.includes("openrouter.ai")) {
          return new Response("no shebang here");
        }
        return new Response("Not Found", {
          status: 404,
        });
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected: validateScriptContent should reject
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject HTML response masquerading as script", async () => {
      await setupFetch(async (url) => {
        if (url.includes("openrouter.ai")) {
          return new Response("<!DOCTYPE html>\n<html><body>Error page</body></html>");
        }
        return new Response("Not Found", {
          status: 404,
        });
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected: validateScriptContent should reject HTML
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
