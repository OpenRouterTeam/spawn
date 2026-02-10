import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for commands.ts error/validation paths that call process.exit(1).
 *
 * These test the ACTUAL exported functions from commands.ts (not inline replicas).
 * Previous tests in commands-helpers.test.ts and commands-untested.test.ts used
 * re-implemented copies of the logic. This file tests the real code paths:
 *
 * - cmdRun with invalid identifiers (injection characters, path traversal)
 * - cmdRun with unknown agent or cloud names
 * - cmdRun with unimplemented agent/cloud combinations
 * - cmdRun with invalid prompts (command injection patterns)
 * - cmdAgentInfo with unknown agent
 * - cmdAgentInfo with invalid identifier
 * - validateNonEmptyString triggering process.exit for empty inputs
 * - validateImplementation showing available clouds when combination is missing
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts to prevent TTY output and capture error/info messages
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mock(() => {}),
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    error: mockLogError,
    warn: mockLogWarn,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import commands after @clack/prompts mock is set up
const { cmdRun, cmdAgentInfo } = await import("../commands.js");

describe("Commands Error Paths", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    // Mock process.exit to throw instead of exiting
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    // Mock fetch to return our controlled manifest data
    originalFetch = global.fetch;
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;

    // Force-refresh the manifest cache
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── cmdRun: identifier validation ─────────────────────────────────────

  describe("cmdRun - identifier validation", () => {
    it("should reject agent name with path traversal characters", async () => {
      await expect(cmdRun("../etc/passwd", "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject agent name with uppercase letters", async () => {
      await expect(cmdRun("Claude", "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject agent name with spaces", async () => {
      await expect(cmdRun("claude code", "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject agent name with shell metacharacters", async () => {
      await expect(cmdRun("claude;rm", "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud name with path traversal", async () => {
      await expect(cmdRun("claude", "../../root")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud name with special characters", async () => {
      await expect(cmdRun("claude", "spr$ite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject agent name exceeding 64 characters", async () => {
      const longName = "a".repeat(65);
      await expect(cmdRun(longName, "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should accept agent name at exactly 64 characters", async () => {
      const name64 = "a".repeat(64);
      // This will pass identifier validation but fail at validateAgent (unknown agent)
      await expect(cmdRun(name64, "sprite")).rejects.toThrow("process.exit");
      // It should get past identifier validation -- the error should be from validateAgent
      expect(mockLogError).toHaveBeenCalled();
    });
  });

  // ── cmdRun: unknown agent/cloud ───────────────────────────────────────

  describe("cmdRun - unknown agent or cloud", () => {
    it("should exit with error for unknown agent", async () => {
      await expect(cmdRun("nonexistent", "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);

      // Should show "Unknown agent" error via @clack/prompts log.error
      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown agent"))).toBe(true);
    });

    it("should suggest spawn agents command for unknown agent", async () => {
      await expect(cmdRun("nonexistent", "sprite")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn agents"))).toBe(true);
    });

    it("should exit with error for unknown cloud", async () => {
      await expect(cmdRun("claude", "nonexistent")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown cloud"))).toBe(true);
    });

    it("should suggest spawn clouds command for unknown cloud", async () => {
      await expect(cmdRun("claude", "nonexistent")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
    });
  });

  // ── cmdRun: unimplemented combination ─────────────────────────────────

  describe("cmdRun - unimplemented combination", () => {
    it("should exit with error for unimplemented agent/cloud combination", async () => {
      // hetzner/aider is "missing" in mock manifest
      await expect(cmdRun("aider", "hetzner")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should suggest available clouds when combination is not implemented", async () => {
      // hetzner/aider is "missing", but sprite/aider is "implemented"
      await expect(cmdRun("aider", "hetzner")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // Should suggest sprite as an alternative
      expect(infoCalls.some((msg: string) => msg.includes("spawn aider sprite"))).toBe(true);
    });

    it("should show how many clouds are available", async () => {
      await expect(cmdRun("aider", "hetzner")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // aider has 1 implemented cloud (sprite)
      expect(infoCalls.some((msg: string) => msg.includes("1 cloud"))).toBe(true);
    });
  });

  // ── cmdRun: prompt validation ─────────────────────────────────────────

  describe("cmdRun - prompt validation", () => {
    it("should reject prompt with command substitution $()", async () => {
      await expect(cmdRun("claude", "sprite", "$(rm -rf /)")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject prompt with backtick command substitution", async () => {
      await expect(cmdRun("claude", "sprite", "`whoami`")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject prompt piping to bash", async () => {
      await expect(cmdRun("claude", "sprite", "echo test | bash")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject prompt with rm -rf chain", async () => {
      await expect(cmdRun("claude", "sprite", "fix bugs; rm -rf /")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject empty prompt", async () => {
      await expect(cmdRun("claude", "sprite", "")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject prompt exceeding 10KB", async () => {
      const largePrompt = "a".repeat(10 * 1024 + 1);
      await expect(cmdRun("claude", "sprite", largePrompt)).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── cmdAgentInfo: error paths ─────────────────────────────────────────

  describe("cmdAgentInfo - error paths", () => {
    it("should exit with error for unknown agent", async () => {
      await expect(cmdAgentInfo("nonexistent")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown agent"))).toBe(true);
    });

    it("should reject agent with invalid identifier characters", async () => {
      await expect(cmdAgentInfo("../hack")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject agent with uppercase letters", async () => {
      await expect(cmdAgentInfo("Claude")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject empty agent name", async () => {
      await expect(cmdAgentInfo("")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject whitespace-only agent name", async () => {
      await expect(cmdAgentInfo("   ")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── cmdRun: empty input validation ────────────────────────────────────

  describe("cmdRun - empty input handling", () => {
    it("should reject empty cloud name", async () => {
      await expect(cmdRun("claude", "")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject whitespace-only cloud name", async () => {
      await expect(cmdRun("claude", "   ")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject empty agent name", async () => {
      await expect(cmdRun("", "sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── cmdRun: valid input reaches script download ───────────────────────

  describe("cmdRun - valid inputs proceed past validation", () => {
    it("should pass validation for valid agent and cloud and attempt download", async () => {
      // Mock fetch to simulate script download failure (not a valid script)
      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        // Script download returns non-script content
        return {
          ok: true,
          text: async () => "not a valid script",
        };
      }) as any;

      // Force refresh manifest with updated fetch
      await loadManifest(true);

      // cmdRun should pass validation and attempt to download + run the script.
      // It will fail at validateScriptContent because "not a valid script" lacks shebang.
      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected - either process.exit from validateScriptContent or Error thrown
      }

      // The log.step should have been called with the launch message
      // (meaning validation passed and it attempted to download)
      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("Claude Code") && msg.includes("Sprite"))).toBe(true);
    });

    it("should show prompt indicator when prompt is provided", async () => {
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
          text: async () => "not a valid script",
        };
      }) as any;

      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite", "Fix all bugs");
      } catch {
        // Expected
      }

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(true);
    });
  });

  // ── cmdRun: swapped arguments detection ──────────────────────────────

  describe("cmdRun - swapped arguments detection", () => {
    it("should detect when cloud and agent arguments are swapped", async () => {
      // "spawn sprite claude" should detect that sprite is a cloud and claude is an agent
      await expect(cmdRun("sprite", "claude")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(true);
    });

    it("should suggest the correct argument order when swapped", async () => {
      await expect(cmdRun("sprite", "claude")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn claude sprite"))).toBe(true);
    });

    it("should suggest correct order for hetzner/aider swap", async () => {
      await expect(cmdRun("hetzner", "aider")).rejects.toThrow("process.exit");

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(true);

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn aider hetzner"))).toBe(true);
    });

    it("should NOT trigger swap detection when both args are unknown", async () => {
      await expect(cmdRun("unknown1", "unknown2")).rejects.toThrow("process.exit");

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });

    it("should NOT trigger swap detection when agent is valid", async () => {
      // "spawn claude nonexistent" - agent is valid, cloud is not
      await expect(cmdRun("claude", "nonexistent")).rejects.toThrow("process.exit");

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });
  });
});
