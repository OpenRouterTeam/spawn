import { describe, it, expect } from "bun:test";
import { formatRelativeTime } from "../commands.js";

/**
 * Tests for formatRelativeTime (commands.ts).
 *
 * formatRelativeTime converts ISO timestamps to human-readable relative times
 * ("just now", "5 minutes ago", "yesterday", etc.) for spawn list history.
 *
 * Agent: ux-engineer
 */

describe("formatRelativeTime", () => {
  // Use a fixed reference time: 2026-02-12T12:00:00Z
  const now = new Date("2026-02-12T12:00:00.000Z");

  describe("seconds range", () => {
    it("should return 'just now' for timestamps less than 60 seconds ago", () => {
      expect(formatRelativeTime("2026-02-12T11:59:30.000Z", now)).toBe("just now");
    });

    it("should return 'just now' for timestamps 0 seconds ago", () => {
      expect(formatRelativeTime("2026-02-12T12:00:00.000Z", now)).toBe("just now");
    });

    it("should return 'just now' for timestamps 59 seconds ago", () => {
      expect(formatRelativeTime("2026-02-12T11:59:01.000Z", now)).toBe("just now");
    });
  });

  describe("minutes range", () => {
    it("should return '1 minute ago' for 60 seconds ago", () => {
      expect(formatRelativeTime("2026-02-12T11:59:00.000Z", now)).toBe("1 minute ago");
    });

    it("should return '2 minutes ago' for 2 minutes ago", () => {
      expect(formatRelativeTime("2026-02-12T11:58:00.000Z", now)).toBe("2 minutes ago");
    });

    it("should return '59 minutes ago' for 59 minutes ago", () => {
      expect(formatRelativeTime("2026-02-12T11:01:00.000Z", now)).toBe("59 minutes ago");
    });

    it("should return '30 minutes ago' for 30 minutes ago", () => {
      expect(formatRelativeTime("2026-02-12T11:30:00.000Z", now)).toBe("30 minutes ago");
    });
  });

  describe("hours range", () => {
    it("should return '1 hour ago' for 60 minutes ago", () => {
      expect(formatRelativeTime("2026-02-12T11:00:00.000Z", now)).toBe("1 hour ago");
    });

    it("should return '2 hours ago' for 2 hours ago", () => {
      expect(formatRelativeTime("2026-02-12T10:00:00.000Z", now)).toBe("2 hours ago");
    });

    it("should return '23 hours ago' for 23 hours ago", () => {
      expect(formatRelativeTime("2026-02-11T13:00:00.000Z", now)).toBe("23 hours ago");
    });

    it("should return '12 hours ago' for 12 hours ago", () => {
      expect(formatRelativeTime("2026-02-12T00:00:00.000Z", now)).toBe("12 hours ago");
    });
  });

  describe("days range", () => {
    it("should return 'yesterday' for 24 hours ago", () => {
      expect(formatRelativeTime("2026-02-11T12:00:00.000Z", now)).toBe("yesterday");
    });

    it("should return '2 days ago' for 2 days ago", () => {
      expect(formatRelativeTime("2026-02-10T12:00:00.000Z", now)).toBe("2 days ago");
    });

    it("should return '6 days ago' for 6 days ago", () => {
      expect(formatRelativeTime("2026-02-06T12:00:00.000Z", now)).toBe("6 days ago");
    });
  });

  describe("weeks range", () => {
    it("should return '1 week ago' for 7 days ago", () => {
      expect(formatRelativeTime("2026-02-05T12:00:00.000Z", now)).toBe("1 week ago");
    });

    it("should return '2 weeks ago' for 14 days ago", () => {
      expect(formatRelativeTime("2026-01-29T12:00:00.000Z", now)).toBe("2 weeks ago");
    });

    it("should return '4 weeks ago' for 28 days ago", () => {
      expect(formatRelativeTime("2026-01-15T12:00:00.000Z", now)).toBe("4 weeks ago");
    });
  });

  describe("beyond a month (falls back to absolute)", () => {
    it("should return absolute date for timestamps over 5 weeks ago", () => {
      const result = formatRelativeTime("2025-12-01T12:00:00.000Z", now);
      // Should fall back to absolute format (contains month name and year)
      expect(result).toContain("Dec");
      expect(result).toContain("2025");
    });

    it("should return absolute date for timestamps months ago", () => {
      const result = formatRelativeTime("2025-06-15T12:00:00.000Z", now);
      expect(result).toContain("Jun");
      expect(result).toContain("2025");
    });
  });

  describe("edge cases", () => {
    it("should fall back to absolute for future timestamps", () => {
      const result = formatRelativeTime("2026-03-01T12:00:00.000Z", now);
      // Future dates should use absolute format
      expect(result).toContain("Mar");
      expect(result).toContain("2026");
    });

    it("should return raw string for invalid ISO timestamps", () => {
      expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
    });

    it("should return raw string for empty string", () => {
      expect(formatRelativeTime("")).toBe("");
    });

    it("should work without explicit now parameter (uses real time)", () => {
      // A timestamp from 1 second ago should return "just now"
      const recent = new Date(Date.now() - 1000).toISOString();
      expect(formatRelativeTime(recent)).toBe("just now");
    });

    it("should handle epoch zero gracefully", () => {
      const result = formatRelativeTime("1970-01-01T00:00:00.000Z", now);
      // Very old - should fall back to absolute
      expect(result).toContain("1970");
    });

    it("should handle exactly 1 hour boundary", () => {
      // 1 hour and 30 minutes = 90 minutes = 1 hour (floored)
      expect(formatRelativeTime("2026-02-12T10:30:00.000Z", now)).toBe("1 hour ago");
    });

    it("should handle exactly 1 day boundary", () => {
      // 1 day and 12 hours = 36 hours = 1 day (floored)
      expect(formatRelativeTime("2026-02-11T00:00:00.000Z", now)).toBe("yesterday");
    });

    it("should handle exactly 1 week boundary", () => {
      // 8 days = 1 week (floored)
      expect(formatRelativeTime("2026-02-04T12:00:00.000Z", now)).toBe("1 week ago");
    });
  });
});
