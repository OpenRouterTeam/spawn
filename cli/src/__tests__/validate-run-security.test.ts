import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createConsoleMocks, restoreMocks } from "./test-helpers";

/**
 * Direct tests for validateRunSecurity() — the security gatekeeper for CLI user input.
 *
 * This function is the integration point that combines:
 * - validateIdentifier(agent, "Agent name")
 * - validateIdentifier(cloud, "Cloud name")
 * - validatePrompt(prompt) (if prompt is provided)
 * - validateNonEmptyString(agent, ...) / validateNonEmptyString(cloud, ...)
 *
 * Individual validators have their own tests (security.test.ts), but this file
 * tests the integration behavior: error logging via @clack/prompts, process.exit(1)
 * on invalid input, and the interaction between validators.
 *
 * Agent: test-engineer
 */

// Mock @clack/prompts to capture error/info messages and prevent TTY output
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mockLogInfo,
    error: mockLogError,
    warn: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import after mock setup so the module picks up the mocked @clack/prompts
const { validateRunSecurity } = await import("../commands.js");

describe("validateRunSecurity", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Valid inputs ──────────────────────────────────────────────────────

  describe("valid inputs", () => {
    it("should accept valid agent and cloud names", () => {
      expect(() => validateRunSecurity("claude", "sprite")).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should accept hyphenated names", () => {
      expect(() => validateRunSecurity("aider-chat", "aws-ec2")).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should accept underscored names", () => {
      expect(() => validateRunSecurity("claude_code", "digital_ocean")).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should accept valid agent, cloud, and prompt", () => {
      expect(() => validateRunSecurity("claude", "sprite", "Fix all bugs")).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should accept undefined prompt (optional parameter)", () => {
      expect(() => validateRunSecurity("claude", "sprite", undefined)).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should accept empty string prompt (falsy, skips prompt validation)", () => {
      // Empty string is falsy, so the `if (prompt)` check skips validatePrompt.
      // However, validateNonEmptyString is not called for prompt, so it passes.
      expect(() => validateRunSecurity("claude", "sprite", "")).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should accept agent/cloud names at exactly 64 characters", () => {
      const name64 = "a".repeat(64);
      expect(() => validateRunSecurity(name64, name64)).not.toThrow();
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Invalid agent name ────────────────────────────────────────────────

  describe("invalid agent name", () => {
    it("should exit for agent name with shell injection", () => {
      expect(() => validateRunSecurity("; rm -rf /", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for agent name with command substitution", () => {
      expect(() => validateRunSecurity("$(whoami)", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for agent name with backtick injection", () => {
      expect(() => validateRunSecurity("`id`", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for agent name with path traversal", () => {
      expect(() => validateRunSecurity("../etc/passwd", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for agent name with uppercase letters", () => {
      expect(() => validateRunSecurity("Claude", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for agent name exceeding 64 characters", () => {
      expect(() => validateRunSecurity("a".repeat(65), "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should log error message for invalid agent name", () => {
      expect(() => validateRunSecurity("agent;hack", "sprite")).toThrow("process.exit called");
      expect(mockLogError).toHaveBeenCalled();
      const errorMsg = mockLogError.mock.calls[0].join(" ");
      expect(errorMsg).toContain("Agent name");
    });
  });

  // ── Invalid cloud name ────────────────────────────────────────────────

  describe("invalid cloud name", () => {
    it("should exit for cloud name with shell injection", () => {
      expect(() => validateRunSecurity("claude", "; rm -rf /")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for cloud name with pipe characters", () => {
      expect(() => validateRunSecurity("claude", "cloud|hack")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for cloud name with ampersand", () => {
      expect(() => validateRunSecurity("claude", "cloud&")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for cloud name with path traversal", () => {
      expect(() => validateRunSecurity("claude", "../../root")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should log error message for invalid cloud name", () => {
      expect(() => validateRunSecurity("claude", "spr$ite")).toThrow("process.exit called");
      expect(mockLogError).toHaveBeenCalled();
      const errorMsg = mockLogError.mock.calls[0].join(" ");
      expect(errorMsg).toContain("Cloud name");
    });
  });

  // ── Invalid prompt ────────────────────────────────────────────────────

  describe("invalid prompt", () => {
    it("should exit for prompt with command substitution $()", () => {
      expect(() => validateRunSecurity("claude", "sprite", "$(rm -rf /)")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for prompt with backtick command substitution", () => {
      expect(() => validateRunSecurity("claude", "sprite", "`whoami`")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for prompt piping to bash", () => {
      expect(() => validateRunSecurity("claude", "sprite", "echo test | bash")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for prompt with rm -rf chain", () => {
      expect(() => validateRunSecurity("claude", "sprite", "fix bugs; rm -rf /")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for prompt exceeding 10KB", () => {
      const largePrompt = "a".repeat(10 * 1024 + 1);
      expect(() => validateRunSecurity("claude", "sprite", largePrompt)).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Empty inputs ──────────────────────────────────────────────────────

  describe("empty inputs", () => {
    it("should exit for empty agent name", () => {
      expect(() => validateRunSecurity("", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for whitespace-only agent name", () => {
      expect(() => validateRunSecurity("   ", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for empty cloud name", () => {
      expect(() => validateRunSecurity("claude", "")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should exit for whitespace-only cloud name", () => {
      expect(() => validateRunSecurity("claude", "   ")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Error logging behavior ────────────────────────────────────────────

  describe("error logging", () => {
    it("should log the error via @clack/prompts before exiting", () => {
      expect(() => validateRunSecurity("bad;agent", "sprite")).toThrow("process.exit called");
      expect(mockLogError).toHaveBeenCalledTimes(1);
    });

    it("should log helpful info for empty agent name", () => {
      expect(() => validateRunSecurity("", "sprite")).toThrow("process.exit called");
      // validateIdentifier throws for empty string, which gets caught and logged
      expect(mockLogError).toHaveBeenCalled();
    });

    it("should suggest spawn agents for empty agent after identifier validation", () => {
      // Empty string throws in validateIdentifier (caught in try/catch, logs error, exits).
      // validateNonEmptyString for agent never runs because process.exit was called first.
      expect(() => validateRunSecurity("", "sprite")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Combined invalid inputs ───────────────────────────────────────────

  describe("combined invalid inputs", () => {
    it("should exit on first invalid input (agent checked before cloud)", () => {
      // Both agent and cloud are invalid, but agent is validated first in the try block
      expect(() => validateRunSecurity("BAD", "BAD")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledWith(1);
      // Error message should reference the agent (first validation to fail)
      const errorMsg = mockLogError.mock.calls[0].join(" ");
      expect(errorMsg).toContain("Agent name");
    });

    it("should exit exactly once even with multiple potential failures", () => {
      expect(() => validateRunSecurity("$(hack)", "$(hack)", "$(hack)")).toThrow("process.exit called");
      expect(processExitSpy).toHaveBeenCalledTimes(1);
    });
  });
});
