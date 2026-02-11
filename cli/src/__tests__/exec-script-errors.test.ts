import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for execScript bash execution error handling in commands.ts.
 *
 * When a spawn script fails, the CLI shows exit-code-specific error messages
 * to help users troubleshoot. These error paths (lines 427-455 in commands.ts)
 * have zero direct test coverage:
 *
 * - Exit code 127: "A required command was not found" (missing bash/curl/ssh/jq)
 * - Exit code 126: "A command was found but could not be executed" (permission denied)
 * - Exit code 130: Silent exit for Ctrl+C (user interrupt)
 * - Generic failures: "Common causes" with credential/rate-limit/dependency hints
 * - runBash: Sets SPAWN_PROMPT and SPAWN_MODE env vars when prompt is provided
 * - runBash: Resolves successfully for exit code 0
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
const { cmdRun } = await import("../commands.js");

describe("execScript bash execution error handling", () => {
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

  /** Helper to set up fetch that returns a bash script with the given body */
  function mockFetchWithScript(scriptBody: string) {
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
        text: async () => `#!/bin/bash\nset -eo pipefail\n${scriptBody}`,
      };
    }) as any;
  }

  /** Get combined error output from console.error and @clack/prompts log.error */
  function getErrorOutput(): string {
    const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
    const consoleErrors = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    return [...clackErrors, ...consoleErrors].join("\n");
  }

  // ── Exit code 127: command not found ─────────────────────────────────────

  describe("exit code 127 - command not found", () => {
    it("should show 'command was not found' for exit 127", async () => {
      mockFetchWithScript("exit 127");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected - process.exit
      }

      const errors = getErrorOutput();
      expect(errors).toContain("command was not found");
    });

    it("should list common required commands for exit 127", async () => {
      mockFetchWithScript("exit 127");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("bash");
      expect(errors).toContain("curl");
      expect(errors).toContain("ssh");
      expect(errors).toContain("jq");
    });

    it("should suggest cloud-specific CLI tools for exit 127", async () => {
      mockFetchWithScript("exit 127");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      // Should mention cloud-specific CLI tools with the cloud name
      expect(errors).toContain("spawn sprite");
    });
  });

  // ── Exit code 126: permission denied ─────────────────────────────────────

  describe("exit code 126 - permission denied", () => {
    it("should show 'permission denied' for exit 126", async () => {
      mockFetchWithScript("exit 126");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("could not be executed");
      expect(errors).toContain("permission denied");
    });
  });

  // ── Exit code 130: Ctrl+C (user interrupt) ──────────────────────────────

  describe("exit code 130 - user interrupt", () => {
    it("should exit silently with code 130 for Ctrl+C", async () => {
      mockFetchWithScript("exit 130");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected - process.exit
      }

      // Should exit with 130
      expect(processExitSpy).toHaveBeenCalledWith(130);

      // Should NOT show error messages for Ctrl+C
      const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      const errorMessages = clackErrors.filter((e: string) => e.includes("Spawn script failed"));
      expect(errorMessages).toHaveLength(0);
    });
  });

  // ── Generic exit codes: common causes ────────────────────────────────────

  describe("generic exit codes - common causes", () => {
    it("should show 'Common causes' for generic failures", async () => {
      mockFetchWithScript("exit 1");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("Common causes");
    });

    it("should mention missing credentials for exit code 1", async () => {
      mockFetchWithScript("exit 1");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("credentials");
    });

    it("should mention API errors for exit code 1", async () => {
      mockFetchWithScript("exit 1");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("API error");
    });

    it("should mention local dependencies for other exit codes", async () => {
      mockFetchWithScript("exit 2");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("Missing credentials");
      expect(errors).toContain("curl");
      expect(errors).toContain("jq");
    });

    it("should suggest spawn <cloud> for setup instructions", async () => {
      mockFetchWithScript("exit 1");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("spawn sprite");
    });

    it("should show error label for failed script", async () => {
      mockFetchWithScript("exit 1");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(clackErrors.some((e: string) => e.includes("Spawn script failed"))).toBe(true);
    });

    it("should include exit code in error message", async () => {
      mockFetchWithScript("exit 42");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("42");
    });
  });

  // ── Successful script execution ──────────────────────────────────────────

  describe("successful script execution", () => {
    it("should complete without error for exit code 0", async () => {
      mockFetchWithScript("exit 0");
      await loadManifest(true);

      // Should not throw or call process.exit
      await cmdRun("claude", "sprite");

      const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(clackErrors.filter((e: string) => e.includes("Spawn script failed"))).toHaveLength(0);
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should show launch step message without prompt suffix", async () => {
      mockFetchWithScript("exit 0");
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("Claude Code");
      expect(launchMsg).toContain("Sprite");
      expect(launchMsg).not.toContain("with prompt");
    });

    it("should show launch step message with prompt suffix when prompt provided", async () => {
      mockFetchWithScript("exit 0");
      await loadManifest(true);

      await cmdRun("claude", "sprite", "Fix all bugs");

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("with prompt");
    });
  });

  // ── Exit code extraction from error message ─────────────────────────────

  describe("exit code regex extraction", () => {
    it("should give code-127 guidance for actual command-not-found", async () => {
      // Use a nonexistent command to trigger a real exit code 127
      mockFetchWithScript("nonexistent_command_xyz_12345");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("command was not found");
    });

    it("should give generic guidance for exit code 2", async () => {
      mockFetchWithScript("exit 2");
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const errors = getErrorOutput();
      expect(errors).toContain("Common causes");
    });
  });

  // ── Error message includes exit code ─────────────────────────────────────

  describe("error message includes exit code number", () => {
    for (const exitCode of [1, 2, 126, 127]) {
      it(`should include exit code ${exitCode} in error details`, async () => {
        mockFetchWithScript(`exit ${exitCode}`);
        await loadManifest(true);

        try {
          await cmdRun("claude", "sprite");
        } catch {
          // Expected
        }

        const errors = getErrorOutput();
        expect(errors).toContain(`${exitCode}`);
      });
    }
  });
});
