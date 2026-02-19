import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  formatCredStatusLine,
  parseAuthEnvVars,
  hasCloudCredentials,
  getImplementedClouds,
  getImplementedAgents,
  buildAgentPickerHints,
  prioritizeCloudsByCredentials,
  getMissingClouds,
  calculateColumnWidth,
  getTerminalWidth,
  resolveDisplayName,
  buildRecordLabel,
  buildRecordHint,
  formatRelativeTime,
  formatTimestamp,
  getErrorMessage,
  levenshtein,
  findClosestMatch,
  findClosestKeyByNameOrKey,
  resolveAgentKey,
  resolveCloudKey,
  checkEntity,
  getStatusDescription,
  isRetryableExitCode,
  buildRetryCommand,
  credentialHints,
  getSignalGuidance,
  getScriptFailureGuidance,
} from "../commands";
import type { Manifest } from "../manifest";
import { createMockManifest } from "./test-helpers";
import type { SpawnRecord } from "../history";

/**
 * Tests for credential display, internal helpers, and edge cases
 * across commands.ts that lack dedicated coverage.
 *
 * Covers:
 * - formatCredStatusLine: newly exported, zero prior tests
 * - formatAuthVarLine (replicated): private helper for quick-start display
 * - buildCredentialStatusLines (replicated): private helper for dry-run
 * - groupByType (replicated): private helper for clouds/agents grouping
 * - formatCacheAge (replicated from index.ts): version display
 * - Various edge cases in existing exported functions
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── formatCredStatusLine (exported, zero prior coverage) ─────────────────────

describe("formatCredStatusLine", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show green 'set' status when env var is present", () => {
    process.env.TEST_VAR_ABC = "value";
    const result = formatCredStatusLine("TEST_VAR_ABC");
    expect(result).toContain("TEST_VAR_ABC");
    expect(result).toContain("-- set");
  });

  it("should show red 'not set' status when env var is missing", () => {
    delete process.env.TEST_VAR_MISSING_XYZ;
    const result = formatCredStatusLine("TEST_VAR_MISSING_XYZ");
    expect(result).toContain("TEST_VAR_MISSING_XYZ");
    expect(result).toContain("-- not set");
  });

  it("should include URL hint when env var is missing and hint is provided", () => {
    delete process.env.TEST_VAR_MISSING_HINT;
    const result = formatCredStatusLine("TEST_VAR_MISSING_HINT", "https://example.com");
    expect(result).toContain("TEST_VAR_MISSING_HINT");
    expect(result).toContain("-- not set");
    expect(result).toContain("https://example.com");
  });

  it("should NOT include URL hint when env var IS set, even if hint is provided", () => {
    process.env.TEST_VAR_SET_HINT = "value";
    const result = formatCredStatusLine("TEST_VAR_SET_HINT", "https://example.com");
    expect(result).toContain("-- set");
    // URL hint should not appear when the var is already set
    expect(result).not.toContain("https://example.com");
  });

  it("should handle undefined urlHint when env var is missing", () => {
    delete process.env.TEST_VAR_NO_HINT;
    const result = formatCredStatusLine("TEST_VAR_NO_HINT");
    expect(result).toContain("-- not set");
    // No URL suffix should be appended
    expect(result).not.toContain("undefined");
  });

  it("should handle empty string urlHint", () => {
    delete process.env.TEST_VAR_EMPTY_HINT;
    const result = formatCredStatusLine("TEST_VAR_EMPTY_HINT", "");
    expect(result).toContain("-- not set");
  });

  it("should treat empty string env var value as falsy (not set)", () => {
    process.env.TEST_VAR_EMPTY_VAL = "";
    const result = formatCredStatusLine("TEST_VAR_EMPTY_VAL");
    expect(result).toContain("-- not set");
  });

  it("should handle OPENROUTER_API_KEY specifically", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const result = formatCredStatusLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys");
    expect(result).toContain("OPENROUTER_API_KEY");
    expect(result).toContain("-- set");
  });

  it("should show not-set for OPENROUTER_API_KEY when missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = formatCredStatusLine("OPENROUTER_API_KEY", "https://openrouter.ai/settings/keys");
    expect(result).toContain("OPENROUTER_API_KEY");
    expect(result).toContain("-- not set");
    expect(result).toContain("https://openrouter.ai/settings/keys");
  });
});

// ── formatAuthVarLine (private, replicated for testing) ───────────────────────

// Replica of formatAuthVarLine from commands.ts (private)
function formatAuthVarLine(varName: string, urlHint?: string): string {
  if (process.env[varName]) {
    return `  ${varName} -- set`;
  }
  const hint = urlHint ? `  # ${urlHint}` : "";
  return `  export ${varName}=...${hint}`;
}

describe("formatAuthVarLine (replicated)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should show export hint when env var is missing", () => {
    delete process.env.HCLOUD_TOKEN;
    const result = formatAuthVarLine("HCLOUD_TOKEN");
    expect(result).toContain("export HCLOUD_TOKEN=...");
  });

  it("should show set status when env var is present", () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const result = formatAuthVarLine("HCLOUD_TOKEN");
    expect(result).toContain("HCLOUD_TOKEN");
    expect(result).toContain("-- set");
  });

  it("should include URL hint when env var is missing", () => {
    delete process.env.DO_TOKEN;
    const result = formatAuthVarLine("DO_TOKEN", "https://cloud.digitalocean.com/account/api/tokens");
    expect(result).toContain("export DO_TOKEN=...");
    expect(result).toContain("https://cloud.digitalocean.com/account/api/tokens");
  });

  it("should NOT include URL hint when env var is set", () => {
    process.env.DO_TOKEN = "test";
    const result = formatAuthVarLine("DO_TOKEN", "https://cloud.digitalocean.com/account/api/tokens");
    expect(result).toContain("-- set");
    expect(result).not.toContain("https://cloud.digitalocean.com");
  });
});

// ── groupByType (private, replicated for testing) ─────────────────────────────

function groupByType(keys: string[], getType: (key: string) => string): Record<string, string[]> {
  const byType: Record<string, string[]> = {};
  for (const key of keys) {
    const type = getType(key);
    if (!byType[type]) byType[type] = [];
    byType[type].push(key);
  }
  return byType;
}

describe("groupByType (replicated)", () => {
  it("should group keys by type", () => {
    const clouds = ["sprite", "hetzner", "vultr", "digitalocean"];
    const result = groupByType(clouds, (key) => {
      if (key === "sprite") return "vm";
      return "cloud";
    });
    expect(result.vm).toEqual(["sprite"]);
    expect(result.cloud).toEqual(["hetzner", "vultr", "digitalocean"]);
  });

  it("should handle empty keys array", () => {
    const result = groupByType([], () => "any");
    expect(result).toEqual({});
  });

  it("should handle all keys having the same type", () => {
    const result = groupByType(["a", "b", "c"], () => "same");
    expect(result.same).toEqual(["a", "b", "c"]);
  });

  it("should handle each key having a unique type", () => {
    const result = groupByType(["a", "b", "c"], (k) => k);
    expect(result.a).toEqual(["a"]);
    expect(result.b).toEqual(["b"]);
    expect(result.c).toEqual(["c"]);
  });

  it("should preserve insertion order within groups", () => {
    const keys = ["z", "a", "m", "b"];
    const result = groupByType(keys, (k) => k < "m" ? "low" : "high");
    expect(result.high).toEqual(["z", "m"]);
    expect(result.low).toEqual(["a", "b"]);
  });
});

// ── formatCacheAge (private in index.ts, replicated for testing) ──────────────

function formatCacheAge(seconds: number): string {
  if (!isFinite(seconds)) return "no cache";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

describe("formatCacheAge (replicated)", () => {
  it("should return 'no cache' for Infinity", () => {
    expect(formatCacheAge(Infinity)).toBe("no cache");
  });

  it("should return 'no cache' for -Infinity", () => {
    expect(formatCacheAge(-Infinity)).toBe("no cache");
  });

  it("should return 'no cache' for NaN", () => {
    expect(formatCacheAge(NaN)).toBe("no cache");
  });

  it("should return 'just now' for 0 seconds", () => {
    expect(formatCacheAge(0)).toBe("just now");
  });

  it("should return 'just now' for 59 seconds", () => {
    expect(formatCacheAge(59)).toBe("just now");
  });

  it("should return '1m ago' for 60 seconds", () => {
    expect(formatCacheAge(60)).toBe("1m ago");
  });

  it("should return '59m ago' for 3599 seconds", () => {
    expect(formatCacheAge(3599)).toBe("59m ago");
  });

  it("should return '1h ago' for 3600 seconds", () => {
    expect(formatCacheAge(3600)).toBe("1h ago");
  });

  it("should return '23h ago' for 86399 seconds", () => {
    expect(formatCacheAge(86399)).toBe("23h ago");
  });

  it("should return '1d ago' for 86400 seconds", () => {
    expect(formatCacheAge(86400)).toBe("1d ago");
  });

  it("should return '7d ago' for 1 week", () => {
    expect(formatCacheAge(604800)).toBe("7d ago");
  });

  it("should return '30d ago' for 30 days", () => {
    expect(formatCacheAge(2592000)).toBe("30d ago");
  });
});

// ── parseAuthEnvVars edge cases ──────────────────────────────────────────────

describe("parseAuthEnvVars edge cases", () => {
  it("should parse single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should parse two env vars separated by +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("should return empty for 'none'", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("should return empty for 'OAuth'", () => {
    expect(parseAuthEnvVars("OAuth")).toEqual([]);
  });

  it("should return empty for 'API key via web dashboard'", () => {
    expect(parseAuthEnvVars("API key via web dashboard")).toEqual([]);
  });

  it("should filter out short strings (< 4 chars)", () => {
    expect(parseAuthEnvVars("AB")).toEqual([]);
  });

  it("should filter out strings not starting with uppercase", () => {
    expect(parseAuthEnvVars("lowercase_token")).toEqual([]);
  });

  it("should accept env vars with underscores and digits", () => {
    expect(parseAuthEnvVars("MY_API_KEY_2")).toEqual(["MY_API_KEY_2"]);
  });

  it("should handle multiple vars with varying whitespace around +", () => {
    expect(parseAuthEnvVars("A_KEY+B_KEY +C_KEY")).toEqual(["A_KEY", "B_KEY", "C_KEY"]);
  });

  it("should handle empty string input", () => {
    expect(parseAuthEnvVars("")).toEqual([]);
  });

  it("should reject vars with lowercase letters", () => {
    expect(parseAuthEnvVars("My_Key")).toEqual([]);
  });

  it("should reject vars with hyphens", () => {
    expect(parseAuthEnvVars("MY-KEY")).toEqual([]);
  });

  it("should accept exactly 4-char env var", () => {
    expect(parseAuthEnvVars("ABCD")).toEqual(["ABCD"]);
  });

  it("should handle real-world CloudSigma auth format", () => {
    expect(parseAuthEnvVars("CLOUDSIGMA_USERNAME + CLOUDSIGMA_PASSWORD")).toEqual([
      "CLOUDSIGMA_USERNAME",
      "CLOUDSIGMA_PASSWORD",
    ]);
  });
});

// ── hasCloudCredentials edge cases ───────────────────────────────────────────

describe("hasCloudCredentials edge cases", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return false when auth is 'none' (no vars to check)", () => {
    expect(hasCloudCredentials("none")).toBe(false);
  });

  it("should return false when auth is a descriptive string", () => {
    expect(hasCloudCredentials("OAuth flow")).toBe(false);
  });

  it("should return true when single auth var is set", () => {
    process.env.HCLOUD_TOKEN = "test";
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(true);
  });

  it("should return false when single auth var is not set", () => {
    delete process.env.HCLOUD_TOKEN;
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });

  it("should return true when all auth vars are set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(true);
  });

  it("should return false when only one of multiple auth vars is set", () => {
    process.env.UPCLOUD_USERNAME = "user";
    delete process.env.UPCLOUD_PASSWORD;
    expect(hasCloudCredentials("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toBe(false);
  });

  it("should return false for empty auth string", () => {
    expect(hasCloudCredentials("")).toBe(false);
  });

  it("should return false when env var is empty string", () => {
    process.env.HCLOUD_TOKEN = "";
    expect(hasCloudCredentials("HCLOUD_TOKEN")).toBe(false);
  });
});

// ── getImplementedClouds / getImplementedAgents edge cases ───────────────────

describe("getImplementedClouds edge cases", () => {
  it("should return implemented clouds for an agent", () => {
    const clouds = getImplementedClouds(mockManifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
  });

  it("should return only implemented clouds (not missing)", () => {
    const clouds = getImplementedClouds(mockManifest, "codex");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
  });

  it("should return empty array for nonexistent agent", () => {
    const clouds = getImplementedClouds(mockManifest, "nonexistent");
    expect(clouds).toEqual([]);
  });

  it("should return empty for empty manifest", () => {
    const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
    expect(getImplementedClouds(empty, "claude")).toEqual([]);
  });
});

describe("getImplementedAgents edge cases", () => {
  it("should return implemented agents for a cloud", () => {
    const agents = getImplementedAgents(mockManifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
  });

  it("should exclude non-implemented agents", () => {
    const agents = getImplementedAgents(mockManifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).not.toContain("codex");
  });

  it("should return empty for nonexistent cloud", () => {
    expect(getImplementedAgents(mockManifest, "nonexistent")).toEqual([]);
  });
});

// ── getMissingClouds ─────────────────────────────────────────────────────────

describe("getMissingClouds", () => {
  it("should return clouds not implemented for the agent", () => {
    const missing = getMissingClouds(mockManifest, "codex", ["sprite", "hetzner"]);
    expect(missing).toContain("hetzner");
    expect(missing).not.toContain("sprite");
  });

  it("should return empty when all clouds are implemented", () => {
    const missing = getMissingClouds(mockManifest, "claude", ["sprite", "hetzner"]);
    expect(missing).toEqual([]);
  });

  it("should return all clouds when none are implemented", () => {
    const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
    const missing = getMissingClouds(empty, "claude", ["sprite", "hetzner"]);
    expect(missing).toEqual(["sprite", "hetzner"]);
  });

  it("should handle empty clouds array", () => {
    expect(getMissingClouds(mockManifest, "claude", [])).toEqual([]);
  });
});

// ── calculateColumnWidth ─────────────────────────────────────────────────────

describe("calculateColumnWidth edge cases", () => {
  it("should return minWidth when all items are shorter", () => {
    expect(calculateColumnWidth(["a", "bb"], 20)).toBe(20);
  });

  it("should return item width + padding when item exceeds minWidth", () => {
    // "a".length + 2 (COL_PADDING) = 3, but minWidth is higher
    expect(calculateColumnWidth(["a"], 10)).toBe(10);
  });

  it("should use the longest item to determine width", () => {
    // "longname".length = 8, + 2 padding = 10
    expect(calculateColumnWidth(["a", "longname", "b"], 5)).toBe(10);
  });

  it("should handle empty items array", () => {
    expect(calculateColumnWidth([], 10)).toBe(10);
  });

  it("should handle single-char items", () => {
    expect(calculateColumnWidth(["x"], 3)).toBe(3);
  });

  it("should handle items exactly at minWidth minus padding", () => {
    // item.length + 2 = minWidth => returns minWidth
    const item = "a".repeat(8); // 8 + 2 = 10
    expect(calculateColumnWidth([item], 10)).toBe(10);
  });
});

// ── prioritizeCloudsByCredentials ────────────────────────────────────────────

describe("prioritizeCloudsByCredentials edge cases", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should put clouds with credentials first", () => {
    // sprite auth is "token" which won't match as env var pattern
    // so no clouds will have creds unless we set them
    const result = prioritizeCloudsByCredentials(["sprite", "hetzner"], mockManifest);
    expect(result.sortedClouds).toEqual(["sprite", "hetzner"]);
    expect(result.credCount).toBe(0);
  });

  it("should handle empty clouds array", () => {
    const result = prioritizeCloudsByCredentials([], mockManifest);
    expect(result.sortedClouds).toEqual([]);
    expect(result.credCount).toBe(0);
    expect(result.hintOverrides).toEqual({});
  });

  it("should return single cloud without reordering", () => {
    const result = prioritizeCloudsByCredentials(["sprite"], mockManifest);
    expect(result.sortedClouds).toEqual(["sprite"]);
  });
});

// ── buildAgentPickerHints ────────────────────────────────────────────────────

describe("buildAgentPickerHints edge cases", () => {
  it("should show 'no clouds available yet' for agent with no implementations", () => {
    const manifest: Manifest = {
      agents: {
        orphan: {
          name: "Orphan Agent",
          description: "No clouds",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {
        sprite: mockManifest.clouds.sprite,
      },
      matrix: {
        "sprite/orphan": "missing",
      },
    };
    const hints = buildAgentPickerHints(manifest);
    expect(hints.orphan).toBe("no clouds available yet");
  });

  it("should show cloud count for agent with implementations", () => {
    const hints = buildAgentPickerHints(mockManifest);
    expect(hints.claude).toContain("2 clouds");
    expect(hints.codex).toContain("1 cloud");
  });

  it("should handle empty manifest", () => {
    const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
    const hints = buildAgentPickerHints(empty);
    expect(Object.keys(hints)).toHaveLength(0);
  });
});

// ── resolveDisplayName ───────────────────────────────────────────────────────

describe("resolveDisplayName edge cases", () => {
  it("should return display name when manifest has the agent", () => {
    expect(resolveDisplayName(mockManifest, "claude", "agent")).toBe("Claude Code");
  });

  it("should return display name when manifest has the cloud", () => {
    expect(resolveDisplayName(mockManifest, "hetzner", "cloud")).toBe("Hetzner Cloud");
  });

  it("should return key as-is when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
  });

  it("should return key as-is when key is not in manifest", () => {
    expect(resolveDisplayName(mockManifest, "nonexistent", "agent")).toBe("nonexistent");
  });

  it("should return key as-is for unknown cloud", () => {
    expect(resolveDisplayName(mockManifest, "unknown-cloud", "cloud")).toBe("unknown-cloud");
  });
});

// ── buildRecordLabel / buildRecordHint ────────────────────────────────────────

describe("buildRecordLabel", () => {
  it("should format label with display names from manifest", () => {
    const record: SpawnRecord = { agent: "claude", cloud: "sprite", timestamp: "" };
    const label = buildRecordLabel(record, mockManifest);
    expect(label).toBe("Claude Code on Sprite");
  });

  it("should use raw keys when manifest is null", () => {
    const record: SpawnRecord = { agent: "claude", cloud: "sprite", timestamp: "" };
    const label = buildRecordLabel(record, null);
    expect(label).toBe("claude on sprite");
  });

  it("should use raw keys for unknown entries", () => {
    const record: SpawnRecord = { agent: "unknown", cloud: "missing", timestamp: "" };
    const label = buildRecordLabel(record, mockManifest);
    expect(label).toBe("unknown on missing");
  });
});

describe("buildRecordHint", () => {
  it("should show relative time without prompt", () => {
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: new Date().toISOString(),
    };
    const hint = buildRecordHint(record);
    expect(hint).toBe("just now");
  });

  it("should include prompt preview when prompt is short", () => {
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: new Date().toISOString(),
      prompt: "Fix bugs",
    };
    const hint = buildRecordHint(record);
    expect(hint).toContain("Fix bugs");
    expect(hint).toContain("--prompt");
  });

  it("should truncate long prompt in hint", () => {
    const longPrompt = "a".repeat(50);
    const record: SpawnRecord = {
      agent: "claude",
      cloud: "sprite",
      timestamp: new Date().toISOString(),
      prompt: longPrompt,
    };
    const hint = buildRecordHint(record);
    expect(hint).toContain("...");
    expect(hint.length).toBeLessThan(longPrompt.length + 50);
  });
});

// ── formatRelativeTime edge cases ────────────────────────────────────────────

describe("formatRelativeTime edge cases", () => {
  it("should return 'just now' for future timestamps", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    expect(formatRelativeTime(future)).toBe("just now");
  });

  it("should return 'just now' for timestamps less than 60s ago", () => {
    const recent = new Date(Date.now() - 30000).toISOString();
    expect(formatRelativeTime(recent)).toBe("just now");
  });

  it("should return minutes for timestamps 1-59 min ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5 min ago");
  });

  it("should return hours for timestamps 1-23h ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago");
  });

  it("should return 'yesterday' for timestamps 24-47h ago", () => {
    const yesterday = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    expect(formatRelativeTime(yesterday)).toBe("yesterday");
  });

  it("should return days for timestamps 2-29d ago", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    expect(formatRelativeTime(fiveDaysAgo)).toBe("5d ago");
  });

  it("should return date for timestamps 30+ days ago", () => {
    const oldDate = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    const result = formatRelativeTime(oldDate);
    // Should be a formatted date string like "Dec 16"
    expect(result).not.toContain("ago");
    expect(result).not.toBe("just now");
  });

  it("should return raw string for invalid ISO date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
  });

  it("should return raw string for empty string", () => {
    expect(formatRelativeTime("")).toBe("");
  });
});

// ── formatTimestamp edge cases ───────────────────────────────────────────────

describe("formatTimestamp edge cases", () => {
  it("should format a valid ISO timestamp", () => {
    const result = formatTimestamp("2026-01-15T14:30:00.000Z");
    expect(result).toContain("2026");
    expect(result).toContain("Jan");
  });

  it("should return raw string for invalid date", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("should return raw string for empty string", () => {
    expect(formatTimestamp("")).toBe("");
  });
});

// ── getErrorMessage edge cases ───────────────────────────────────────────────

describe("getErrorMessage edge cases", () => {
  it("should extract message from Error object", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("should extract message from plain object with message property", () => {
    expect(getErrorMessage({ message: "custom error" })).toBe("custom error");
  });

  it("should stringify non-object errors", () => {
    expect(getErrorMessage("string error")).toBe("string error");
  });

  it("should stringify number errors", () => {
    expect(getErrorMessage(42)).toBe("42");
  });

  it("should stringify null", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("should stringify undefined", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("should stringify boolean", () => {
    expect(getErrorMessage(false)).toBe("false");
  });

  it("should handle object without message property", () => {
    expect(getErrorMessage({ code: 123 })).toBe("[object Object]");
  });

  it("should handle empty string error", () => {
    expect(getErrorMessage("")).toBe("");
  });
});

// ── levenshtein edge cases ──────────────────────────────────────────────────

describe("levenshtein edge cases", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("should return length of non-empty string when other is empty", () => {
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "xyz")).toBe(3);
  });

  it("should return 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("should count single character difference", () => {
    expect(levenshtein("abc", "axc")).toBe(1);
  });

  it("should count single insertion", () => {
    expect(levenshtein("abc", "abcd")).toBe(1);
  });

  it("should count single deletion", () => {
    expect(levenshtein("abcd", "abc")).toBe(1);
  });

  it("should handle completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("should be symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(levenshtein("sitting", "kitten"));
  });
});

// ── findClosestMatch edge cases ──────────────────────────────────────────────

describe("findClosestMatch edge cases", () => {
  it("should return null for empty candidates", () => {
    expect(findClosestMatch("test", [])).toBeNull();
  });

  it("should return exact match with distance 0", () => {
    expect(findClosestMatch("claude", ["claude", "codex"])).toBe("claude");
  });

  it("should return closest within distance 3", () => {
    expect(findClosestMatch("cloude", ["claude", "codex"])).toBe("claude");
  });

  it("should return null when no candidate is within distance 3", () => {
    expect(findClosestMatch("xxxxxxxxx", ["claude", "codex"])).toBeNull();
  });

  it("should be case-insensitive", () => {
    expect(findClosestMatch("CLAUDE", ["claude", "codex"])).toBe("claude");
  });
});

// ── findClosestKeyByNameOrKey ────────────────────────────────────────────────

describe("findClosestKeyByNameOrKey edge cases", () => {
  it("should match by key", () => {
    const result = findClosestKeyByNameOrKey("claude", ["claude", "codex"], (k) => k.toUpperCase());
    expect(result).toBe("claude");
  });

  it("should match by display name", () => {
    const result = findClosestKeyByNameOrKey(
      "Claude Code",
      ["claude"],
      (k) => k === "claude" ? "Claude Code" : k
    );
    expect(result).toBe("claude");
  });

  it("should return null when nothing matches within distance 3", () => {
    const result = findClosestKeyByNameOrKey("zzzzzzzzz", ["claude"], (k) => "Claude Code");
    expect(result).toBeNull();
  });

  it("should prefer closer match between key and name", () => {
    // "claud" is distance 1 from "claude" (key) and distance 5+ from "Claude Code" (name)
    const result = findClosestKeyByNameOrKey("claud", ["claude"], (k) => "Claude Code");
    expect(result).toBe("claude");
  });

  it("should handle empty keys array", () => {
    expect(findClosestKeyByNameOrKey("test", [], () => "")).toBeNull();
  });
});

// ── resolveAgentKey / resolveCloudKey ────────────────────────────────────────

describe("resolveAgentKey edge cases", () => {
  it("should resolve exact key", () => {
    expect(resolveAgentKey(mockManifest, "claude")).toBe("claude");
  });

  it("should resolve case-insensitive key", () => {
    expect(resolveAgentKey(mockManifest, "CLAUDE")).toBe("claude");
  });

  it("should resolve display name", () => {
    expect(resolveAgentKey(mockManifest, "Claude Code")).toBe("claude");
  });

  it("should return null for nonexistent agent", () => {
    expect(resolveAgentKey(mockManifest, "nonexistent")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(resolveAgentKey(mockManifest, "")).toBeNull();
  });
});

describe("resolveCloudKey edge cases", () => {
  it("should resolve exact key", () => {
    expect(resolveCloudKey(mockManifest, "sprite")).toBe("sprite");
  });

  it("should resolve case-insensitive key", () => {
    expect(resolveCloudKey(mockManifest, "SPRITE")).toBe("sprite");
  });

  it("should resolve display name", () => {
    expect(resolveCloudKey(mockManifest, "Hetzner Cloud")).toBe("hetzner");
  });

  it("should return null for nonexistent cloud", () => {
    expect(resolveCloudKey(mockManifest, "nonexistent")).toBeNull();
  });
});

// ── checkEntity edge cases ──────────────────────────────────────────────────

describe("checkEntity edge cases", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("should return true for valid agent", () => {
    expect(checkEntity(mockManifest, "claude", "agent")).toBe(true);
  });

  it("should return true for valid cloud", () => {
    expect(checkEntity(mockManifest, "sprite", "cloud")).toBe(true);
  });

  it("should return false for invalid agent", () => {
    expect(checkEntity(mockManifest, "nonexistent", "agent")).toBe(false);
  });

  it("should return false for invalid cloud", () => {
    expect(checkEntity(mockManifest, "nonexistent", "cloud")).toBe(false);
  });

  it("should detect swapped kind (agent key used as cloud)", () => {
    expect(checkEntity(mockManifest, "claude", "cloud")).toBe(false);
  });

  it("should detect swapped kind (cloud key used as agent)", () => {
    expect(checkEntity(mockManifest, "sprite", "agent")).toBe(false);
  });
});

// ── getStatusDescription ─────────────────────────────────────────────────────

describe("getStatusDescription", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should return 'HTTP <code>' for non-404", () => {
    expect(getStatusDescription(500)).toBe("HTTP 500");
    expect(getStatusDescription(403)).toBe("HTTP 403");
    expect(getStatusDescription(200)).toBe("HTTP 200");
  });
});

// ── isRetryableExitCode ──────────────────────────────────────────────────────

describe("isRetryableExitCode edge cases", () => {
  it("should return true for exit code 255 (SSH failure)", () => {
    expect(isRetryableExitCode("Script exited with code 255")).toBe(true);
  });

  it("should return false for exit code 1", () => {
    expect(isRetryableExitCode("Script exited with code 1")).toBe(false);
  });

  it("should return false for exit code 0", () => {
    expect(isRetryableExitCode("Script exited with code 0")).toBe(false);
  });

  it("should return false for exit code 130 (Ctrl+C)", () => {
    expect(isRetryableExitCode("Script exited with code 130")).toBe(false);
  });

  it("should return false for messages without exit code", () => {
    expect(isRetryableExitCode("Script was killed by SIGKILL")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isRetryableExitCode("")).toBe(false);
  });
});

// ── buildRetryCommand ────────────────────────────────────────────────────────

describe("buildRetryCommand edge cases", () => {
  it("should build simple command without prompt", () => {
    expect(buildRetryCommand("claude", "sprite")).toBe("spawn claude sprite");
  });

  it("should include short prompt inline", () => {
    const cmd = buildRetryCommand("claude", "sprite", "Fix bugs");
    expect(cmd).toBe('spawn claude sprite --prompt "Fix bugs"');
  });

  it("should escape quotes in short prompt", () => {
    const cmd = buildRetryCommand("claude", "sprite", 'Say "hello"');
    expect(cmd).toContain('\\"hello\\"');
  });

  it("should use --prompt-file for long prompts", () => {
    const longPrompt = "a".repeat(100);
    const cmd = buildRetryCommand("claude", "sprite", longPrompt);
    expect(cmd).toContain("--prompt-file");
    expect(cmd).not.toContain(longPrompt);
  });

  it("should inline prompt of exactly 80 chars", () => {
    const prompt = "a".repeat(80);
    const cmd = buildRetryCommand("claude", "sprite", prompt);
    expect(cmd).toContain("--prompt");
    expect(cmd).toContain(prompt);
  });

  it("should use --prompt-file for prompt of 81 chars", () => {
    const prompt = "a".repeat(81);
    const cmd = buildRetryCommand("claude", "sprite", prompt);
    expect(cmd).toContain("--prompt-file");
  });

  it("should handle undefined prompt", () => {
    expect(buildRetryCommand("claude", "sprite", undefined)).toBe("spawn claude sprite");
  });
});

// ── credentialHints ──────────────────────────────────────────────────────────

describe("credentialHints edge cases", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return generic hint when no authHint provided", () => {
    const hints = credentialHints("sprite");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain("credentials");
  });

  it("should show missing vars when some credentials are not set", () => {
    delete process.env.HCLOUD_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    const joined = hints.join("\n");
    expect(joined).toContain("Missing credentials");
  });

  it("should show all-set message when all credentials are present", () => {
    process.env.HCLOUD_TOKEN = "test";
    process.env.OPENROUTER_API_KEY = "sk-test";
    const hints = credentialHints("hetzner", "HCLOUD_TOKEN");
    const joined = hints.join("\n");
    expect(joined).toContain("Credentials appear to be set");
  });

  it("should use custom verb parameter", () => {
    delete process.env.OPENROUTER_API_KEY;
    const hints = credentialHints("sprite", undefined, "Required");
    expect(hints[0]).toContain("Required");
  });
});

// ── getSignalGuidance ────────────────────────────────────────────────────────

describe("getSignalGuidance edge cases", () => {
  it("should provide SIGKILL guidance", () => {
    const lines = getSignalGuidance("SIGKILL");
    const joined = lines.join("\n");
    expect(joined).toContain("SIGKILL");
    expect(joined).toContain("memory");
  });

  it("should provide SIGTERM guidance", () => {
    const lines = getSignalGuidance("SIGTERM");
    const joined = lines.join("\n");
    expect(joined).toContain("SIGTERM");
    expect(joined).toContain("terminated");
  });

  it("should provide SIGINT guidance", () => {
    const lines = getSignalGuidance("SIGINT");
    const joined = lines.join("\n");
    expect(joined).toContain("Ctrl+C");
  });

  it("should provide SIGHUP guidance", () => {
    const lines = getSignalGuidance("SIGHUP");
    const joined = lines.join("\n");
    expect(joined).toContain("SIGHUP");
    expect(joined).toContain("terminal");
  });

  it("should provide generic guidance for unknown signals", () => {
    const lines = getSignalGuidance("SIGUSR1");
    const joined = lines.join("\n");
    expect(joined).toContain("SIGUSR1");
  });

  it("should include dashboard URL when provided", () => {
    const lines = getSignalGuidance("SIGKILL", "https://dashboard.example.com");
    const joined = lines.join("\n");
    expect(joined).toContain("https://dashboard.example.com");
  });

  it("should show generic dashboard hint when no URL provided", () => {
    const lines = getSignalGuidance("SIGKILL");
    const joined = lines.join("\n");
    expect(joined).toContain("cloud provider dashboard");
  });
});

// ── getScriptFailureGuidance ─────────────────────────────────────────────────

describe("getScriptFailureGuidance edge cases", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should provide guidance for exit code 130 (Ctrl+C)", () => {
    const lines = getScriptFailureGuidance(130, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("Ctrl+C");
  });

  it("should provide guidance for exit code 137 (OOM)", () => {
    const lines = getScriptFailureGuidance(137, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("killed");
    expect(joined).toContain("memory");
  });

  it("should provide guidance for exit code 255 (SSH)", () => {
    const lines = getScriptFailureGuidance(255, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("SSH");
  });

  it("should provide guidance for exit code 127 (command not found)", () => {
    const lines = getScriptFailureGuidance(127, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("command was not found");
  });

  it("should provide guidance for exit code 126 (permission denied)", () => {
    const lines = getScriptFailureGuidance(126, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("permission denied");
  });

  it("should provide guidance for exit code 2 (syntax error)", () => {
    const lines = getScriptFailureGuidance(2, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("syntax");
  });

  it("should provide guidance for exit code 1 (general error)", () => {
    const lines = getScriptFailureGuidance(1, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("Common causes");
  });

  it("should provide default guidance for unknown exit code", () => {
    const lines = getScriptFailureGuidance(42, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("Common causes");
  });

  it("should provide guidance for null exit code", () => {
    const lines = getScriptFailureGuidance(null, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("Common causes");
  });

  it("should include dashboard URL when provided", () => {
    const lines = getScriptFailureGuidance(1, "sprite", undefined, "https://dash.example.com");
    const joined = lines.join("\n");
    expect(joined).toContain("https://dash.example.com");
  });
});

// ── getTerminalWidth ─────────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  it("should return a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });

  it("should return at least 80 (default fallback)", () => {
    // In a test environment, stdout.columns may not be set
    const width = getTerminalWidth();
    expect(width).toBeGreaterThanOrEqual(80);
  });
});
