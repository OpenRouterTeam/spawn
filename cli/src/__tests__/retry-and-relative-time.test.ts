import { describe, it, expect } from "bun:test";
import { buildRetryCommand, formatRelativeTime } from "../commands";

/**
 * Tests for:
 * - buildRetryCommand: includes --prompt in failure retry suggestions
 * - formatRelativeTime: shows relative timestamps for recent entries
 *
 * Agent: ux-engineer
 */

// ── buildRetryCommand ────────────────────────────────────────────────────────

describe("buildRetryCommand", () => {
  it("should return basic command without prompt", () => {
    expect(buildRetryCommand("claude", "sprite")).toBe("spawn claude sprite");
  });

  it("should include short prompt with --prompt flag", () => {
    expect(buildRetryCommand("claude", "sprite", "Fix bugs")).toBe(
      'spawn claude sprite --prompt "Fix bugs"'
    );
  });

  it("should truncate prompt longer than 60 characters", () => {
    const longPrompt = "A".repeat(61);
    const result = buildRetryCommand("claude", "sprite", longPrompt);
    expect(result).toContain("--prompt");
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(
      `spawn claude sprite --prompt "${longPrompt}"`.length
    );
  });

  it("should not truncate prompt at exactly 60 characters", () => {
    const prompt60 = "B".repeat(60);
    const result = buildRetryCommand("claude", "sprite", prompt60);
    expect(result).toBe(`spawn claude sprite --prompt "${prompt60}"`);
    expect(result).not.toContain("...");
  });

  it("should escape double quotes in prompt", () => {
    const result = buildRetryCommand("claude", "sprite", 'Fix "this" bug');
    expect(result).toContain('\\"this\\"');
    expect(result).not.toContain('"this"');
  });

  it("should handle empty string prompt like no prompt", () => {
    expect(buildRetryCommand("claude", "sprite", "")).toBe("spawn claude sprite");
  });

  it("should handle undefined prompt", () => {
    expect(buildRetryCommand("aider", "hetzner", undefined)).toBe("spawn aider hetzner");
  });

  it("should preserve different agent and cloud names", () => {
    expect(buildRetryCommand("aider", "digitalocean", "Write tests")).toBe(
      'spawn aider digitalocean --prompt "Write tests"'
    );
  });
});

// ── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  const now = new Date("2026-02-12T12:00:00.000Z");

  it("should return 'just now' for timestamps within the last minute", () => {
    const thirtySecsAgo = new Date(now.getTime() - 30_000).toISOString();
    expect(formatRelativeTime(thirtySecsAgo, now)).toBe("just now");
  });

  it("should return minutes ago for timestamps within the last hour", () => {
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo, now)).toBe("5 min ago");
  });

  it("should return '1 min ago' at exactly 60 seconds", () => {
    const oneMinAgo = new Date(now.getTime() - 60_000).toISOString();
    expect(formatRelativeTime(oneMinAgo, now)).toBe("1 min ago");
  });

  it("should return '59 min ago' at 59 minutes", () => {
    const fiftyNineMin = new Date(now.getTime() - 59 * 60_000).toISOString();
    expect(formatRelativeTime(fiftyNineMin, now)).toBe("59 min ago");
  });

  it("should return hours ago for timestamps within the last day", () => {
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo, now)).toBe("3h ago");
  });

  it("should return '1h ago' at exactly 60 minutes", () => {
    const oneHourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
    expect(formatRelativeTime(oneHourAgo, now)).toBe("1h ago");
  });

  it("should return days ago for timestamps within the last week", () => {
    const twoDaysAgo = new Date(now.getTime() - 2 * 86400_000).toISOString();
    expect(formatRelativeTime(twoDaysAgo, now)).toBe("2d ago");
  });

  it("should return '1d ago' at exactly 24 hours", () => {
    const oneDayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
    expect(formatRelativeTime(oneDayAgo, now)).toBe("1d ago");
  });

  it("should return '6d ago' at 6 days", () => {
    const sixDaysAgo = new Date(now.getTime() - 6 * 86400_000).toISOString();
    expect(formatRelativeTime(sixDaysAgo, now)).toBe("6d ago");
  });

  it("should return absolute date for timestamps older than 7 days", () => {
    const eightDaysAgo = new Date(now.getTime() - 8 * 86400_000).toISOString();
    const result = formatRelativeTime(eightDaysAgo, now);
    // Should contain the year since it's an absolute date
    expect(result).toContain("2026");
    expect(result).toContain("Feb");
  });

  it("should return absolute date for very old timestamps", () => {
    const result = formatRelativeTime("2025-01-15T14:30:00.000Z", now);
    expect(result).toContain("2025");
    expect(result).toContain("Jan");
  });

  it("should return raw string for invalid dates", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
  });

  it("should return empty string for empty input", () => {
    expect(formatRelativeTime("", now)).toBe("");
  });

  it("should return absolute date for future timestamps", () => {
    const future = new Date(now.getTime() + 86400_000).toISOString();
    const result = formatRelativeTime(future, now);
    expect(result).toContain("2026");
  });

  it("should return 'just now' for exactly 0 seconds difference", () => {
    expect(formatRelativeTime(now.toISOString(), now)).toBe("just now");
  });
});
