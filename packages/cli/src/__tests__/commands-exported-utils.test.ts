import { describe, it, expect } from "bun:test";
import {
  parseAuthEnvVars,
  getImplementedAgents,
  getImplementedClouds,
  getMissingClouds,
  getErrorMessage,
  getStatusDescription,
  calculateColumnWidth,
  getTerminalWidth,
  formatRelativeTime,
} from "../commands";
import { createMockManifest, createEmptyManifest } from "./test-helpers";

/**
 * Tests for exported utility functions in commands.ts that lacked
 * direct unit test coverage.
 *
 * Previously tested functions like levenshtein, findClosestMatch,
 * resolveAgentKey, resolveCloudKey were tested via the ACTUAL exports.
 * But several other exported functions were either untested or only
 * tested via inline replicas (not the real code). This file tests
 * the ACTUAL exports.
 *
 * Functions tested here:
 * - parseAuthEnvVars: parses cloud auth strings into env var names
 * - getImplementedAgents: returns agents implemented on a cloud
 * - getMissingClouds: returns clouds where an agent is NOT implemented
 * - getErrorMessage: duck-typed error message extraction
 * - getStatusDescription: HTTP status to human-readable string
 * - calculateColumnWidth: matrix display column sizing
 * - getTerminalWidth: terminal width with fallback
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── parseAuthEnvVars ──────────────────────────────────────────────────────────

describe("parseAuthEnvVars", () => {
  describe("single env var", () => {
    it("should extract a single uppercase env var", () => {
      expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual([
        "HCLOUD_TOKEN",
      ]);
    });

    it("should extract env var with digits", () => {
      expect(parseAuthEnvVars("API_KEY_V2")).toEqual([
        "API_KEY_V2",
      ]);
    });

    it("should extract env var starting with letter followed by digits", () => {
      expect(parseAuthEnvVars("DO_API_TOKEN")).toEqual([
        "DO_API_TOKEN",
      ]);
    });
  });

  describe("multiple env vars separated by +", () => {
    it("should extract two env vars joined by +", () => {
      expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
        "UPCLOUD_USERNAME",
        "UPCLOUD_PASSWORD",
      ]);
    });

    it("should handle multiple + separators", () => {
      expect(parseAuthEnvVars("VAR_ONE + VAR_TWO + VAR_THREE")).toEqual([
        "VAR_ONE",
        "VAR_TWO",
        "VAR_THREE",
      ]);
    });

    it("should handle + without spaces", () => {
      expect(parseAuthEnvVars("VAR_ONE+VAR_TWO")).toEqual([
        "VAR_ONE",
        "VAR_TWO",
      ]);
    });

    it("should handle + with inconsistent spacing", () => {
      expect(parseAuthEnvVars("VAR_ONE +VAR_TWO+ VAR_THREE")).toEqual([
        "VAR_ONE",
        "VAR_TWO",
        "VAR_THREE",
      ]);
    });
  });

  describe("filtering non-env-var tokens", () => {
    it("should filter out lowercase words", () => {
      expect(parseAuthEnvVars("token")).toEqual([]);
    });

    it("should filter out mixed case words that don't start with uppercase", () => {
      expect(parseAuthEnvVars("oAuthToken")).toEqual([]);
    });

    it("should filter out 'OAuth + browser'", () => {
      // Real manifest auth values include "OAuth + browser"
      expect(parseAuthEnvVars("OAuth + browser")).toEqual([]);
    });

    it("should filter out 'none'", () => {
      expect(parseAuthEnvVars("none")).toEqual([]);
    });

    it("should filter out short uppercase strings (< 4 chars after first)", () => {
      // Regex requires [A-Z][A-Z0-9_]{3,} — minimum 4 total chars
      expect(parseAuthEnvVars("API")).toEqual([]);
      expect(parseAuthEnvVars("AB")).toEqual([]);
    });

    it("should accept env vars at exactly 4 characters", () => {
      // [A-Z] (1 char) + [A-Z0-9_]{3,} (3 chars) = 4 total
      expect(parseAuthEnvVars("ABCD")).toEqual([
        "ABCD",
      ]);
    });

    it("should filter out strings starting with a digit", () => {
      expect(parseAuthEnvVars("1VAR")).toEqual([]);
    });

    it("should filter out strings with lowercase letters", () => {
      expect(parseAuthEnvVars("My_Token")).toEqual([]);
    });

    it("should filter out strings with special characters", () => {
      expect(parseAuthEnvVars("API-KEY")).toEqual([]);
      expect(parseAuthEnvVars("API.KEY")).toEqual([]);
      expect(parseAuthEnvVars("API$KEY")).toEqual([]);
    });
  });

  describe("mixed valid and invalid tokens", () => {
    it("should extract valid env vars and filter invalid from mixed auth", () => {
      expect(parseAuthEnvVars("VULTR_API_KEY + oauth")).toEqual([
        "VULTR_API_KEY",
      ]);
    });

    it("should handle 'MODAL_TOKEN_ID + MODAL_TOKEN_SECRET'", () => {
      expect(parseAuthEnvVars("MODAL_TOKEN_ID + MODAL_TOKEN_SECRET")).toEqual([
        "MODAL_TOKEN_ID",
        "MODAL_TOKEN_SECRET",
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      expect(parseAuthEnvVars("")).toEqual([]);
    });

    it("should handle string with only whitespace", () => {
      expect(parseAuthEnvVars("   ")).toEqual([]);
    });

    it("should handle string with only +", () => {
      expect(parseAuthEnvVars("+")).toEqual([]);
    });

    it("should handle string with multiple + and no valid vars", () => {
      expect(parseAuthEnvVars("a + b + c")).toEqual([]);
    });

    it("should handle extra whitespace around a single var", () => {
      expect(parseAuthEnvVars("  HCLOUD_TOKEN  ")).toEqual(["HCLOUD_TOKEN"]);
    });

    it("should handle empty token between + separators", () => {
      expect(parseAuthEnvVars("VAR_A + + VAR_B")).toEqual(["VAR_A", "VAR_B"]);
    });
  });
});

// ── getImplementedAgents ──────────────────────────────────────────────────────

describe("getImplementedAgents", () => {
  it("should return all implemented agents for a cloud with full coverage", () => {
    // sprite has claude and codex implemented
    const agents = getImplementedAgents(mockManifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
    expect(agents).toHaveLength(2);
  });

  it("should return only implemented agents for a cloud with partial coverage", () => {
    // hetzner only has claude implemented
    const agents = getImplementedAgents(mockManifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).not.toContain("codex");
    expect(agents).toHaveLength(1);
  });

  it("should return empty array for a cloud not in the matrix", () => {
    const agents = getImplementedAgents(mockManifest, "nonexistent");
    expect(agents).toEqual([]);
  });

  it("should return empty array for empty manifest", () => {
    const empty = createEmptyManifest();
    const agents = getImplementedAgents(empty, "sprite");
    expect(agents).toEqual([]);
  });

  it("should return empty array for cloud with no implementations", () => {
    const manifest = {
      ...mockManifest,
      clouds: {
        ...mockManifest.clouds,
        newcloud: {
          name: "New Cloud",
          description: "Test",
          url: "",
          type: "vm",
          auth: "token",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
    };
    const agents = getImplementedAgents(manifest, "newcloud");
    expect(agents).toEqual([]);
  });
});

// ── getMissingClouds ──────────────────────────────────────────────────────────

describe("getMissingClouds", () => {
  const clouds = [
    "sprite",
    "hetzner",
  ];

  it("should return clouds where the agent is NOT implemented", () => {
    // codex is missing on hetzner
    const missing = getMissingClouds(mockManifest, "codex", clouds);
    expect(missing).toContain("hetzner");
    expect(missing).not.toContain("sprite");
    expect(missing).toHaveLength(1);
  });

  it("should return empty array when agent is implemented on all clouds", () => {
    // claude is implemented on both sprite and hetzner
    const missing = getMissingClouds(mockManifest, "claude", clouds);
    expect(missing).toEqual([]);
  });

  it("should return all clouds when agent is implemented on none", () => {
    const missing = getMissingClouds(mockManifest, "nonexistent", clouds);
    expect(missing).toEqual(clouds);
  });

  it("should handle empty clouds array", () => {
    const missing = getMissingClouds(mockManifest, "claude", []);
    expect(missing).toEqual([]);
  });

  it("should handle empty manifest", () => {
    const empty = createEmptyManifest();
    const missing = getMissingClouds(empty, "claude", [
      "sprite",
    ]);
    expect(missing).toEqual([
      "sprite",
    ]);
  });
});

// ── getErrorMessage ───────────────────────────────────────────────────────────

describe("getErrorMessage", () => {
  it("should extract message from Error instance", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("should extract message from plain object with message property", () => {
    expect(
      getErrorMessage({
        message: "custom error",
      }),
    ).toBe("custom error");
  });

  it("should convert string to string", () => {
    expect(getErrorMessage("string error")).toBe("string error");
  });

  it("should convert number to string", () => {
    expect(getErrorMessage(42)).toBe("42");
  });

  it("should convert null to 'null'", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("should convert undefined to 'undefined'", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("should convert boolean to string", () => {
    expect(getErrorMessage(false)).toBe("false");
    expect(getErrorMessage(true)).toBe("true");
  });

  it("should handle object without message property", () => {
    expect(
      getErrorMessage({
        code: "ENOENT",
      }),
    ).toBe("[object Object]");
  });

  it("should handle empty Error message", () => {
    expect(getErrorMessage(new Error(""))).toBe("");
  });

  it("should handle TypeError", () => {
    expect(getErrorMessage(new TypeError("type mismatch"))).toBe("type mismatch");
  });

  it("should handle object with numeric message", () => {
    expect(
      getErrorMessage({
        message: 123,
      }),
    ).toBe("123");
  });
});

// ── getStatusDescription ──────────────────────────────────────────────────────

describe("getStatusDescription", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should return HTTP prefix for non-404 codes", () => {
    expect(getStatusDescription(200)).toBe("HTTP 200");
    expect(getStatusDescription(500)).toBe("HTTP 500");
    expect(getStatusDescription(403)).toBe("HTTP 403");
    expect(getStatusDescription(502)).toBe("HTTP 502");
    expect(getStatusDescription(503)).toBe("HTTP 503");
  });

  it("should handle zero", () => {
    expect(getStatusDescription(0)).toBe("HTTP 0");
  });
});

// ── calculateColumnWidth ──────────────────────────────────────────────────────

describe("calculateColumnWidth (actual export)", () => {
  it("should return minimum width when items are shorter", () => {
    expect(
      calculateColumnWidth(
        [
          "a",
          "b",
        ],
        15,
      ),
    ).toBe(15);
  });

  it("should expand beyond minimum for long items", () => {
    // COL_PADDING is 2 in commands.ts
    const result = calculateColumnWidth(
      [
        "long-item-name",
      ],
      5,
    );
    expect(result).toBe(14 + 2); // "long-item-name" (14) + COL_PADDING (2)
  });

  it("should handle empty array", () => {
    expect(calculateColumnWidth([], 10)).toBe(10);
  });

  it("should handle single item exactly at minimum width", () => {
    // "12345678" (8) + COL_PADDING (2) = 10; minWidth = 10
    expect(
      calculateColumnWidth(
        [
          "12345678",
        ],
        10,
      ),
    ).toBe(10);
  });

  it("should use the longest item for width", () => {
    const result = calculateColumnWidth(
      [
        "short",
        "a-much-longer-name",
        "mid",
      ],
      5,
    );
    expect(result).toBe(18 + 2); // "a-much-longer-name" (18) + COL_PADDING (2)
  });
});

// ── getTerminalWidth ──────────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  it("should return a number", () => {
    const width = getTerminalWidth();
    expect(typeof width).toBe("number");
  });

  it("should return at least 80 (default fallback)", () => {
    // In test env without a TTY, process.stdout.columns is usually undefined
    // so the fallback to 80 should kick in
    const width = getTerminalWidth();
    expect(width).toBeGreaterThanOrEqual(80);
  });
});

// ── getImplementedClouds (actual export from commands.ts) ─────────────────────

describe("getImplementedClouds (actual export)", () => {
  it("should return implemented clouds for a given agent", () => {
    const clouds = getImplementedClouds(mockManifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
  });

  it("should return subset for agent with partial implementation", () => {
    const clouds = getImplementedClouds(mockManifest, "codex");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
    expect(clouds).toHaveLength(1);
  });

  it("should return empty for nonexistent agent", () => {
    expect(getImplementedClouds(mockManifest, "ghost")).toEqual([]);
  });

  it("should return empty for empty manifest", () => {
    expect(getImplementedClouds(createEmptyManifest(), "claude")).toEqual([]);
  });
});

// ── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  it("should return 'just now' for timestamps less than 60 seconds ago", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("should return 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(future)).toBe("just now");
  });

  it("should return minutes for timestamps 1-59 minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5 min ago");
  });

  it("should return hours for timestamps 1-23 hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago");
  });

  it("should return 'yesterday' for timestamps 24-47 hours ago", () => {
    const oneDayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
    expect(formatRelativeTime(oneDayAgo)).toBe("yesterday");
  });

  it("should return days for timestamps 2-29 days ago", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400_000).toISOString();
    expect(formatRelativeTime(fiveDaysAgo)).toBe("5d ago");
  });

  it("should return month/day for timestamps older than 30 days", () => {
    const oldDate = new Date(Date.now() - 60 * 86400_000).toISOString();
    const result = formatRelativeTime(oldDate);
    // Should be a short date like "Dec 15" rather than a relative time
    expect(result).not.toContain("ago");
    expect(result).not.toContain("yesterday");
  });

  it("should return the raw string for invalid timestamps", () => {
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("should return the raw string for empty string", () => {
    expect(formatRelativeTime("")).toBe("");
  });

  it("should return '1 min ago' at exactly 60 seconds", () => {
    const oneMinAgo = new Date(Date.now() - 60_000).toISOString();
    expect(formatRelativeTime(oneMinAgo)).toBe("1 min ago");
  });

  it("should return '1h ago' at exactly 60 minutes", () => {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(formatRelativeTime(oneHourAgo)).toBe("1h ago");
  });
});
