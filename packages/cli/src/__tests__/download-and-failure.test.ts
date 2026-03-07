import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { loadManifest } from "../manifest";
import { isString } from "../shared/type-guards";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

/**
 * Tests for the download failure pipeline through real code paths in commands/run.ts.
 *
 * Success paths (primary download, fallback download, script validation) are covered
 * by cmdrun-happy-path.test.ts. This file focuses exclusively on failure scenarios:
 *
 * - downloadScriptWithFallback: both fail with 404 (reportDownloadFailure 404+404 path)
 * - downloadScriptWithFallback: primary 500, fallback 500 (server error path)
 * - downloadScriptWithFallback: primary 404, fallback 500 (mixed error path)
 * - downloadScriptWithFallback: network error (reportDownloadError path)
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts to prevent real terminal output
mockClackPrompts();

// Import after mock setup
const { cmdRun } = await import("../commands/index.js");

describe("Download and Failure Pipeline", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  /** Set up fetch to return manifest from manifest URLs and custom responses for script URLs */
  function setupFetch(scriptHandler: (url: string) => Promise<Response>) {
    global.fetch = mock(async (url: string | URL | Request) => {
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

  // ── downloadScriptWithFallback: both fail ─────────────────────────
  // Success paths (primary download, fallback download) are covered
  // by cmdrun-happy-path.test.ts.

  describe("download - both URLs fail", () => {
    it("should show script-not-found error with recovery hints when both return 404", async () => {
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

      const errorOutput = consoleMocks.error.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("doesn't exist");
      expect(errorOutput).toContain("spawn matrix");
      expect(errorOutput).toContain("Report it");
    });

    it("should show server error with retry hint when both return 500", async () => {
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

      const errorOutput = consoleMocks.error.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("HTTP 500");
      expect(errorOutput).toContain("temporarily unavailable");
    });

    it("should show mixed error for primary 404 and fallback 500", async () => {
      await setupFetch(async (url) => {
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
      const errorOutput = consoleMocks.error.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("HTTP 404");
      // 500 from fallback should mention server issues
      expect(errorOutput).toContain("temporarily unavailable");
    });
  });

  // ── downloadScriptWithFallback: network error (fetch throws) ──────

  describe("download - network error", () => {
    it("should exit 1 and include the network error message", async () => {
      await setupFetch(async () => {
        throw new Error("DNS resolution failed");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      expect(processExitSpy).toHaveBeenCalledWith(1);

      const errorOutput = consoleMocks.error.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("DNS resolution failed");
    });

    it("should show troubleshooting hints including firewall, connection check, and fallback URL", async () => {
      await setupFetch(async () => {
        throw new Error("Network timeout");
      });

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errorOutput = consoleMocks.error.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Next steps");
      expect(errorOutput).toContain("internet connection");
      expect(errorOutput).toContain("Firewall");
      expect(errorOutput).toContain("raw.githubusercontent.com");
    });
  });

  // Script content validation tests are covered by cmdrun-happy-path.test.ts
  // (script content validation during download).
});
