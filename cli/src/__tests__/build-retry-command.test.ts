import { describe, it, expect } from "bun:test";
import { buildRetryCommand } from "../commands";

/**
 * Tests for buildRetryCommand() in commands.ts.
 *
 * When a spawn script fails, the CLI shows a "Retry:" line with the command
 * to re-run. Previously this always omitted the --prompt flag, forcing users
 * to retype their prompt. Now the retry command includes the prompt when one
 * was used.
 *
 * Agent: ux-engineer
 */

describe("buildRetryCommand", () => {
  it("should return basic command without prompt", () => {
    expect(buildRetryCommand("claude", "sprite")).toBe("spawn claude sprite");
  });

  it("should include short prompt in retry command", () => {
    expect(buildRetryCommand("claude", "sprite", "Fix all tests")).toBe(
      'spawn claude sprite --prompt "Fix all tests"'
    );
  });

  it("should include prompt up to 80 chars", () => {
    const prompt = "a".repeat(80);
    const result = buildRetryCommand("claude", "hetzner", prompt);
    expect(result).toBe(`spawn claude hetzner --prompt "${prompt}"`);
  });

  it("should truncate prompt longer than 80 chars", () => {
    const prompt = "a".repeat(81);
    const result = buildRetryCommand("claude", "hetzner", prompt);
    expect(result).toBe('spawn claude hetzner --prompt "..."');
  });

  it("should escape double quotes in prompt", () => {
    const result = buildRetryCommand("aider", "vultr", 'Fix the "broken" test');
    expect(result).toBe('spawn aider vultr --prompt "Fix the \\"broken\\" test"');
  });

  it("should handle empty string prompt same as no prompt", () => {
    expect(buildRetryCommand("claude", "sprite", "")).toBe("spawn claude sprite");
  });

  it("should handle undefined prompt", () => {
    expect(buildRetryCommand("claude", "sprite", undefined)).toBe("spawn claude sprite");
  });
});
