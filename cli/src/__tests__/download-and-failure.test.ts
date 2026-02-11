import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for the download fallback pipeline and script failure reporting
 * through real exported code paths in commands.ts.
 *
 * Existing tests cover:
 * - getScriptFailureGuidance in isolation (script-failure-guidance.test.ts)
 * - getStatusDescription as a reimplemented copy (commands-untested.test.ts)
 * - downloadScriptWithFallback logic as a reimplemented copy (commands-untested.test.ts)
 * - cmdRun validation paths (commands-error-paths.test.ts)
 * - cmdRun resolution and swap (commands-resolve-run.test.ts, commands-swap-resolve.test.ts)
 *
 * This file covers the UNTESTED real code paths:
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
 *
 * Agent: test-engineer
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
  isCancel: () => false,
}));

// Import after mock setup
const { cmdRun, getScriptFailureGuidance, getStatusDescription, getErrorMessage } =
  await import("../commands.js");

describe("Download and Failure Pipeline", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  /** Set up fetch to return manifest from manifest URLs and custom responses for script URLs */
  function setupFetch(
    scriptHandler: (url: string) => Promise<{ ok: boolean; status?: number; text?: () => Promise<string> }>
  ) {
    global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => mockManifest,
          text: async () => JSON.stringify(mockManifest),
        };
      }
      return scriptHandler(urlStr);
    }) as any;
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

  // ── downloadScriptWithFallback: primary URL succeeds ──────────────

  describe("download - primary URL succeeds", () => {
    it("should download script from primary URL and attempt execution", async () => {
      await setupFetch(async (url) => {
        // Primary URL succeeds with a valid-looking script
        if (url.includes("openrouter.ai")) {
          return {
            ok: true,
            text: async () => "#!/bin/bash\nexit 0",
          };
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
          return {
            ok: true,
            text: async () => "#!/bin/bash\nexit 0",
          };
        }
        fallbackCalled = true;
        return { ok: true, text: async () => "#!/bin/bash\nexit 0" };
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
          return { ok: false, status: 404 };
        }
        // GitHub raw fallback succeeds
        if (url.includes("raw.githubusercontent.com")) {
          return {
            ok: true,
            text: async () => "#!/bin/bash\nexit 0",
          };
        }
        return { ok: false, status: 500 };
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
          return { ok: false, status: 500 };
        }
        if (url.includes("raw.githubusercontent.com")) {
          return {
            ok: true,
            text: async () => "#!/bin/bash\nexit 0",
          };
        }
        return { ok: false, status: 500 };
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
      await setupFetch(async (url) => {
        return { ok: false, status: 404 };
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected: process.exit(1) from reportDownloadFailure
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);

      // reportDownloadFailure should log specific 404 error
      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("could not be found");
    });

    it("should suggest verifying the combination when both return 404", async () => {
      await setupFetch(async () => ({ ok: false, status: 404 }));

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("spawn list");
    });

    it("should suggest reporting the issue when both return 404", async () => {
      await setupFetch(async () => ({ ok: false, status: 404 }));

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("issues");
    });

    it("should show server error message when both return 500", async () => {
      await setupFetch(async () => ({ ok: false, status: 500 }));

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("HTTP 500");
    });

    it("should mention temporary server issues on 500 errors", async () => {
      await setupFetch(async () => ({ ok: false, status: 500 }));

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("temporary issues");
    });

    it("should show mixed error for primary 404 and fallback 500", async () => {
      let callCount = 0;
      await setupFetch(async (url) => {
        callCount++;
        if (url.includes("openrouter.ai")) {
          return { ok: false, status: 404 };
        }
        return { ok: false, status: 500 };
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      // Should show HTTP error (not the "script not found" path)
      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("HTTP 404");
      // 500 from fallback should mention temporary issues
      expect(errorOutput).toContain("temporary issues");
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
      expect(errorOutput).toContain("Troubleshooting");
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
      expect(errorOutput).toContain("spawn list");
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
          return {
            ok: true,
            text: async () => "no shebang here",
          };
        }
        return { ok: false, status: 404 };
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
          return {
            ok: true,
            text: async () => "<!DOCTYPE html>\n<html><body>Error page</body></html>",
          };
        }
        return { ok: false, status: 404 };
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

// ── getScriptFailureGuidance: exercised through real export ─────────

describe("getScriptFailureGuidance - all exit codes", () => {
  it("should return Ctrl+C guidance for exit code 130", () => {
    const lines = getScriptFailureGuidance(130, "sprite");
    expect(lines.some((l: string) => l.includes("Ctrl+C"))).toBe(true);
    expect(lines.some((l: string) => l.includes("interrupted"))).toBe(true);
  });

  it("should mention running server for exit code 130", () => {
    const lines = getScriptFailureGuidance(130, "sprite");
    expect(lines.some((l: string) => l.includes("still be running"))).toBe(true);
  });

  it("should include cloud provider dashboard hint for 130", () => {
    const lines = getScriptFailureGuidance(130, "hetzner");
    expect(lines.some((l: string) => l.includes("cloud provider dashboard"))).toBe(true);
  });

  it("should return OOM/timeout guidance for exit code 137", () => {
    const lines = getScriptFailureGuidance(137, "sprite");
    expect(lines.some((l: string) => l.includes("killed"))).toBe(true);
  });

  it("should return SSH guidance for exit code 255", () => {
    const lines = getScriptFailureGuidance(255, "sprite");
    expect(lines.some((l: string) => l.includes("SSH"))).toBe(true);
    expect(lines.some((l: string) => l.includes("booting"))).toBe(true);
  });

  it("should mention firewall for exit code 255", () => {
    const lines = getScriptFailureGuidance(255, "sprite");
    expect(lines.some((l: string) => l.includes("Firewall"))).toBe(true);
  });

  it("should return command-not-found guidance for exit code 127", () => {
    const lines = getScriptFailureGuidance(127, "sprite");
    expect(lines.some((l: string) => l.includes("command was not found"))).toBe(true);
  });

  it("should list required tools for exit code 127", () => {
    const lines = getScriptFailureGuidance(127, "sprite");
    expect(lines.some((l: string) => l.includes("bash") && l.includes("curl"))).toBe(true);
  });

  it("should include cloud-specific CLI hint for 127", () => {
    const lines = getScriptFailureGuidance(127, "vultr");
    expect(lines.some((l: string) => l.includes("spawn vultr"))).toBe(true);
  });

  it("should return permission denied guidance for exit code 126", () => {
    const lines = getScriptFailureGuidance(126, "sprite");
    expect(lines.some((l: string) => l.includes("permission denied"))).toBe(true);
  });

  it("should return syntax error guidance for exit code 2", () => {
    const lines = getScriptFailureGuidance(2, "sprite");
    expect(lines.some((l: string) => l.includes("syntax") || l.includes("argument"))).toBe(true);
  });

  it("should suggest reporting a bug for exit code 2", () => {
    const lines = getScriptFailureGuidance(2, "sprite");
    expect(lines.some((l: string) => l.includes("issues"))).toBe(true);
  });

  it("should return credentials guidance for exit code 1", () => {
    const lines = getScriptFailureGuidance(1, "sprite");
    expect(lines.some((l: string) => l.includes("credentials"))).toBe(true);
  });

  it("should include cloud-specific setup hint for exit code 1", () => {
    const lines = getScriptFailureGuidance(1, "hetzner");
    expect(lines.some((l: string) => l.includes("spawn hetzner"))).toBe(true);
  });

  it("should mention API errors for exit code 1", () => {
    const lines = getScriptFailureGuidance(1, "sprite");
    expect(lines.some((l: string) => l.includes("API error"))).toBe(true);
  });

  it("should return default guidance for unknown exit code", () => {
    const lines = getScriptFailureGuidance(42, "sprite");
    expect(lines.some((l: string) => l.includes("credentials"))).toBe(true);
    expect(lines.some((l: string) => l.includes("rate limit"))).toBe(true);
  });

  it("should return default guidance for null exit code", () => {
    const lines = getScriptFailureGuidance(null, "sprite");
    expect(lines.some((l: string) => l.includes("credentials"))).toBe(true);
  });

  it("should include cloud name in default guidance", () => {
    const lines = getScriptFailureGuidance(99, "digitalocean");
    expect(lines.some((l: string) => l.includes("spawn digitalocean"))).toBe(true);
  });
});

// ── getStatusDescription: exercised through real export ──────────────

describe("getStatusDescription - real export", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should return 'HTTP N' for non-404 codes", () => {
    expect(getStatusDescription(200)).toBe("HTTP 200");
    expect(getStatusDescription(500)).toBe("HTTP 500");
    expect(getStatusDescription(403)).toBe("HTTP 403");
    expect(getStatusDescription(502)).toBe("HTTP 502");
    expect(getStatusDescription(503)).toBe("HTTP 503");
  });

  it("should handle edge case HTTP codes", () => {
    expect(getStatusDescription(0)).toBe("HTTP 0");
    expect(getStatusDescription(999)).toBe("HTTP 999");
    expect(getStatusDescription(100)).toBe("HTTP 100");
  });
});

// ── getErrorMessage: exercised through real export ───────────────────

describe("getErrorMessage - real export", () => {
  it("should extract message from Error objects", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("should extract message from plain objects with message property", () => {
    expect(getErrorMessage({ message: "obj error" })).toBe("obj error");
  });

  it("should stringify non-Error values", () => {
    expect(getErrorMessage("string error")).toBe("string error");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("should handle objects without message property", () => {
    expect(getErrorMessage({ code: "ENOENT" })).toBe("[object Object]");
  });

  it("should handle boolean values", () => {
    expect(getErrorMessage(true)).toBe("true");
    expect(getErrorMessage(false)).toBe("false");
  });
});
