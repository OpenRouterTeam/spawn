import { describe, it, expect } from "bun:test";
import {
  getErrorMessage,
  getStatusDescription,
  getScriptFailureGuidance,
  parseAuthEnvVars,
  resolveDisplayName,
  getImplementedClouds,
  getImplementedAgents,
  getMissingClouds,
  calculateColumnWidth,
  getTerminalWidth,
  levenshtein,
  findClosestMatch,
  findClosestKeyByNameOrKey,
  checkEntity,
  resolveAgentKey,
  resolveCloudKey,
} from "../commands.js";
import type { Manifest } from "../manifest.js";
import { createMockManifest } from "./test-helpers";

/**
 * Tests for exported functions from commands.ts called against the REAL module.
 *
 * Many existing test files replicate internal logic as pure functions to test
 * in isolation. This file tests the actual exports directly to catch any
 * divergence between replicas and the real implementation.
 *
 * Coverage areas:
 * - getErrorMessage: duck-typed error extraction (non-Error objects, primitives)
 * - getStatusDescription: HTTP status code formatting
 * - getScriptFailureGuidance: exit-code-to-guidance mapping (all branches)
 * - parseAuthEnvVars: cloud auth string parsing (multi-var, edge cases)
 * - resolveDisplayName: manifest key-to-name resolution with null manifest
 * - getImplementedClouds / getImplementedAgents: matrix filtering
 * - getMissingClouds: inverse matrix filtering
 * - calculateColumnWidth: column width calculation for rendering
 * - levenshtein / findClosestMatch / findClosestKeyByNameOrKey: fuzzy matching
 * - resolveAgentKey / resolveCloudKey: input resolution with case-insensitivity
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── getErrorMessage ──────────────────────────────────────────────────────────

describe("getErrorMessage (real export)", () => {
  it("should extract message from Error objects", () => {
    expect(getErrorMessage(new Error("test error"))).toBe("test error");
  });

  it("should extract message from Error-like objects (duck typing)", () => {
    expect(getErrorMessage({ message: "duck typed" })).toBe("duck typed");
  });

  it("should convert non-Error objects to string", () => {
    expect(getErrorMessage({ code: 42 })).toBe("[object Object]");
  });

  it("should handle string errors", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
  });

  it("should handle number errors", () => {
    expect(getErrorMessage(42)).toBe("42");
  });

  it("should handle null", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("should handle undefined", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("should handle boolean", () => {
    expect(getErrorMessage(false)).toBe("false");
  });

  it("should handle empty message property", () => {
    expect(getErrorMessage({ message: "" })).toBe("");
  });

  it("should handle message property that is a number", () => {
    expect(getErrorMessage({ message: 123 })).toBe("123");
  });

  it("should handle message property that is null", () => {
    expect(getErrorMessage({ message: null })).toBe("null");
  });

  it("should handle Error subclasses", () => {
    expect(getErrorMessage(new TypeError("type err"))).toBe("type err");
    expect(getErrorMessage(new RangeError("range err"))).toBe("range err");
  });
});

// ── getStatusDescription ─────────────────────────────────────────────────────

describe("getStatusDescription (real export)", () => {
  it("should return 'not found' for 404", () => {
    expect(getStatusDescription(404)).toBe("not found");
  });

  it("should format other status codes as 'HTTP N'", () => {
    expect(getStatusDescription(200)).toBe("HTTP 200");
    expect(getStatusDescription(500)).toBe("HTTP 500");
    expect(getStatusDescription(403)).toBe("HTTP 403");
    expect(getStatusDescription(502)).toBe("HTTP 502");
  });

  it("should handle edge case status codes", () => {
    expect(getStatusDescription(0)).toBe("HTTP 0");
    expect(getStatusDescription(999)).toBe("HTTP 999");
    expect(getStatusDescription(100)).toBe("HTTP 100");
  });
});

// ── getScriptFailureGuidance ─────────────────────────────────────────────────

describe("getScriptFailureGuidance (real export)", () => {
  it("should return interrupt message for exit code 130 (Ctrl+C)", () => {
    const lines = getScriptFailureGuidance(130, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("interrupted");
    expect(text).toContain("Ctrl+C");
  });

  it("should return killed message for exit code 137 (OOM/timeout)", () => {
    const lines = getScriptFailureGuidance(137, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("killed");
    expect(text).toContain("RAM");
  });

  it("should return SSH message for exit code 255", () => {
    const lines = getScriptFailureGuidance(255, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("SSH");
    expect(text).toContain("booting");
  });

  it("should return command-not-found message for exit code 127", () => {
    const lines = getScriptFailureGuidance(127, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("command was not found");
    expect(text).toContain("bash");
  });

  it("should return permission message for exit code 126", () => {
    const lines = getScriptFailureGuidance(126, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("permission denied");
  });

  it("should return syntax error message for exit code 2", () => {
    const lines = getScriptFailureGuidance(2, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("syntax");
    expect(text).toContain("bug");
  });

  it("should return generic credentials message for exit code 1", () => {
    const lines = getScriptFailureGuidance(1, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("credentials");
    // Without authHint, shows "run spawn <cloud> for setup" instead of specific env var
    expect(text).toContain("spawn sprite");
  });

  it("should return default guidance for unknown exit codes", () => {
    const lines = getScriptFailureGuidance(42, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("credentials");
  });

  it("should return default guidance for null exit code", () => {
    const lines = getScriptFailureGuidance(null, "sprite");
    const text = lines.join("\n");
    expect(text).toContain("credentials");
  });

  it("should include auth hint when provided for exit code 1", () => {
    const lines = getScriptFailureGuidance(1, "hetzner", "HCLOUD_TOKEN");
    const text = lines.join("\n");
    expect(text).toContain("HCLOUD_TOKEN");
    expect(text).toContain("OPENROUTER_API_KEY");
  });

  it("should include auth hint when provided for default exit code", () => {
    const lines = getScriptFailureGuidance(99, "hetzner", "HCLOUD_TOKEN");
    const text = lines.join("\n");
    expect(text).toContain("HCLOUD_TOKEN");
  });

  it("should show cloud name in setup suggestion without auth hint", () => {
    const lines = getScriptFailureGuidance(1, "vultr");
    const text = lines.join("\n");
    expect(text).toContain("vultr");
  });

  it("should not include auth hint in exit codes that don't use credentials", () => {
    // Exit 130 (interrupt) doesn't mention credentials
    const lines = getScriptFailureGuidance(130, "sprite", "SOME_TOKEN");
    const text = lines.join("\n");
    expect(text).not.toContain("SOME_TOKEN");
  });
});

// ── parseAuthEnvVars ─────────────────────────────────────────────────────────

describe("parseAuthEnvVars (real export)", () => {
  it("should parse single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should parse multiple env vars joined by +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("should filter out non-env-var patterns", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
    expect(parseAuthEnvVars("oauth")).toEqual([]);
    expect(parseAuthEnvVars("browser")).toEqual([]);
  });

  it("should handle 'none' auth", () => {
    expect(parseAuthEnvVars("none")).toEqual([]);
  });

  it("should handle token (lowercase)", () => {
    expect(parseAuthEnvVars("token")).toEqual([]);
  });

  it("should handle empty string", () => {
    expect(parseAuthEnvVars("")).toEqual([]);
  });

  it("should filter out short uppercase strings (3 chars or less)", () => {
    // Pattern requires at least 4+ chars after first uppercase
    expect(parseAuthEnvVars("ABC")).toEqual([]);
    expect(parseAuthEnvVars("AB")).toEqual([]);
  });

  it("should accept 5-char env vars", () => {
    expect(parseAuthEnvVars("ABCDE")).toEqual(["ABCDE"]);
  });

  it("should handle mixed valid and invalid parts", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN + oauth")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should handle env vars with numbers", () => {
    expect(parseAuthEnvVars("AWS_ACCESS_KEY_ID")).toEqual(["AWS_ACCESS_KEY_ID"]);
  });

  it("should reject vars starting with lowercase", () => {
    expect(parseAuthEnvVars("my_token")).toEqual([]);
  });

  it("should reject vars starting with a number", () => {
    expect(parseAuthEnvVars("1_TOKEN")).toEqual([]);
  });

  it("should handle triple env vars", () => {
    const result = parseAuthEnvVars("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION");
    expect(result).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]);
  });

  it("should handle extra whitespace around +", () => {
    expect(parseAuthEnvVars("A_TOKEN  +  B_TOKEN")).toEqual(["A_TOKEN", "B_TOKEN"]);
  });
});

// ── resolveDisplayName ───────────────────────────────────────────────────────

describe("resolveDisplayName (real export)", () => {
  it("should resolve agent key to display name", () => {
    expect(resolveDisplayName(mockManifest, "claude", "agent")).toBe("Claude Code");
  });

  it("should resolve cloud key to display name", () => {
    expect(resolveDisplayName(mockManifest, "sprite", "cloud")).toBe("Sprite");
  });

  it("should return key as-is for unknown agent", () => {
    expect(resolveDisplayName(mockManifest, "unknown-agent", "agent")).toBe("unknown-agent");
  });

  it("should return key as-is for unknown cloud", () => {
    expect(resolveDisplayName(mockManifest, "unknown-cloud", "cloud")).toBe("unknown-cloud");
  });

  it("should return key as-is when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
    expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
  });

  it("should handle empty string key with null manifest", () => {
    expect(resolveDisplayName(null, "", "agent")).toBe("");
  });

  it("should resolve all agents in mock manifest", () => {
    expect(resolveDisplayName(mockManifest, "aider", "agent")).toBe("Aider");
  });

  it("should resolve all clouds in mock manifest", () => {
    expect(resolveDisplayName(mockManifest, "hetzner", "cloud")).toBe("Hetzner Cloud");
  });
});

// ── getImplementedClouds ─────────────────────────────────────────────────────

describe("getImplementedClouds (real export)", () => {
  it("should return implemented clouds for an agent", () => {
    const clouds = getImplementedClouds(mockManifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
    expect(clouds).toHaveLength(2);
  });

  it("should filter out missing implementations", () => {
    const clouds = getImplementedClouds(mockManifest, "aider");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
    expect(clouds).toHaveLength(1);
  });

  it("should return empty array for unknown agent", () => {
    const clouds = getImplementedClouds(mockManifest, "nonexistent");
    expect(clouds).toEqual([]);
  });

  it("should return empty array for empty manifest", () => {
    const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
    expect(getImplementedClouds(empty, "claude")).toEqual([]);
  });
});

// ── getImplementedAgents ─────────────────────────────────────────────────────

describe("getImplementedAgents (real export)", () => {
  it("should return implemented agents for a cloud", () => {
    const agents = getImplementedAgents(mockManifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("aider");
    expect(agents).toHaveLength(2);
  });

  it("should filter out missing implementations", () => {
    const agents = getImplementedAgents(mockManifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).not.toContain("aider");
    expect(agents).toHaveLength(1);
  });

  it("should return empty array for unknown cloud", () => {
    const agents = getImplementedAgents(mockManifest, "nonexistent");
    expect(agents).toEqual([]);
  });

  it("should return empty array for empty manifest", () => {
    const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
    expect(getImplementedAgents(empty, "sprite")).toEqual([]);
  });
});

// ── getMissingClouds ─────────────────────────────────────────────────────────

describe("getMissingClouds (real export)", () => {
  it("should return missing clouds for partially implemented agent", () => {
    const allClouds = Object.keys(mockManifest.clouds);
    const missing = getMissingClouds(mockManifest, "aider", allClouds);
    expect(missing).toContain("hetzner");
    expect(missing).not.toContain("sprite");
  });

  it("should return empty array for fully implemented agent", () => {
    const allClouds = Object.keys(mockManifest.clouds);
    const missing = getMissingClouds(mockManifest, "claude", allClouds);
    expect(missing).toEqual([]);
  });

  it("should return all clouds for unknown agent", () => {
    const allClouds = Object.keys(mockManifest.clouds);
    const missing = getMissingClouds(mockManifest, "nonexistent", allClouds);
    expect(missing).toHaveLength(allClouds.length);
  });

  it("should handle empty cloud list", () => {
    expect(getMissingClouds(mockManifest, "claude", [])).toEqual([]);
  });
});

// ── calculateColumnWidth ─────────────────────────────────────────────────────

describe("calculateColumnWidth (real export)", () => {
  it("should use minimum width when items are shorter", () => {
    expect(calculateColumnWidth(["a", "b"], 20)).toBe(20);
  });

  it("should expand when items exceed minimum width", () => {
    const width = calculateColumnWidth(["Claude Code", "Aider"], 8);
    // "Claude Code" (11) + COL_PADDING (2) = 13
    expect(width).toBe(13);
  });

  it("should use longest item for width calculation", () => {
    const width = calculateColumnWidth(["A", "Long Agent Name Here"], 8);
    // "Long Agent Name Here" (20) + COL_PADDING (2) = 22
    expect(width).toBe(22);
  });

  it("should handle empty array", () => {
    expect(calculateColumnWidth([], 16)).toBe(16);
  });

  it("should handle single item", () => {
    const width = calculateColumnWidth(["Test"], 5);
    // "Test" (4) + padding (2) = 6
    expect(width).toBe(6);
  });

  it("should handle items exactly at minimum width minus padding", () => {
    // Item length 14 + padding 2 = 16 = minWidth, so should return 16
    const width = calculateColumnWidth(["14-char-string"], 16);
    expect(width).toBe(16);
  });
});

// ── getTerminalWidth ─────────────────────────────────────────────────────────

describe("getTerminalWidth (real export)", () => {
  it("should return a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });

  it("should return at least 80 (default fallback)", () => {
    // The function returns process.stdout.columns || 80
    // In test environments without a TTY, this should be 80
    const width = getTerminalWidth();
    expect(width).toBeGreaterThanOrEqual(80);
  });
});

// ── levenshtein ──────────────────────────────────────────────────────────────

describe("levenshtein (real export)", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("should return string length for empty vs non-empty", () => {
    expect(levenshtein("", "hello")).toBe(5);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("should return 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("should count single character substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("should count single character insertion", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });

  it("should count single character deletion", () => {
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("should handle completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("should be symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(levenshtein("sitting", "kitten"));
  });

  it("should handle case-sensitive comparison", () => {
    expect(levenshtein("Hello", "hello")).toBe(1);
  });
});

// ── findClosestMatch ─────────────────────────────────────────────────────────

describe("findClosestMatch (real export)", () => {
  const candidates = ["claude", "aider", "sprite", "hetzner"];

  it("should find exact match", () => {
    expect(findClosestMatch("claude", candidates)).toBe("claude");
  });

  it("should find match with typo within distance 3", () => {
    expect(findClosestMatch("claud", candidates)).toBe("claude");
  });

  it("should find match case-insensitively", () => {
    expect(findClosestMatch("CLAUDE", candidates)).toBe("claude");
  });

  it("should return null for distant strings", () => {
    expect(findClosestMatch("xxxxxxxxx", candidates)).toBeNull();
  });

  it("should return null for empty input", () => {
    expect(findClosestMatch("", candidates)).toBeNull();
  });

  it("should return null for empty candidates", () => {
    expect(findClosestMatch("claude", [])).toBeNull();
  });

  it("should find closest among multiple candidates", () => {
    expect(findClosestMatch("aideer", candidates)).toBe("aider");
  });

  it("should handle single-character typo", () => {
    expect(findClosestMatch("sprits", candidates)).toBe("sprite");
  });
});

// ── findClosestKeyByNameOrKey ────────────────────────────────────────────────

describe("findClosestKeyByNameOrKey (real export)", () => {
  const keys = ["claude", "aider"];
  const getName = (k: string) =>
    k === "claude" ? "Claude Code" : k === "aider" ? "Aider" : k;

  it("should match by key name", () => {
    expect(findClosestKeyByNameOrKey("claud", keys, getName)).toBe("claude");
  });

  it("should match by display name", () => {
    expect(findClosestKeyByNameOrKey("Claude Cod", keys, getName)).toBe("claude");
  });

  it("should match case-insensitively", () => {
    expect(findClosestKeyByNameOrKey("AIDER", keys, getName)).toBe("aider");
  });

  it("should return null for distant input", () => {
    expect(findClosestKeyByNameOrKey("xxxxxxxxxx", keys, getName)).toBeNull();
  });

  it("should return null for empty keys", () => {
    expect(findClosestKeyByNameOrKey("test", [], getName)).toBeNull();
  });

  it("should prefer closer match", () => {
    // "aide" is distance 1 from "aider" key, distance 6+ from "Claude Code" name
    expect(findClosestKeyByNameOrKey("aide", keys, getName)).toBe("aider");
  });
});

// ── resolveAgentKey / resolveCloudKey ────────────────────────────────────────

describe("resolveAgentKey (real export)", () => {
  it("should resolve exact key match", () => {
    expect(resolveAgentKey(mockManifest, "claude")).toBe("claude");
  });

  it("should resolve case-insensitive key match", () => {
    expect(resolveAgentKey(mockManifest, "Claude")).toBe("claude");
    expect(resolveAgentKey(mockManifest, "CLAUDE")).toBe("claude");
  });

  it("should resolve by display name", () => {
    expect(resolveAgentKey(mockManifest, "Claude Code")).toBe("claude");
    expect(resolveAgentKey(mockManifest, "Aider")).toBe("aider");
  });

  it("should resolve case-insensitive display name", () => {
    expect(resolveAgentKey(mockManifest, "claude code")).toBe("claude");
    expect(resolveAgentKey(mockManifest, "CLAUDE CODE")).toBe("claude");
  });

  it("should return null for unknown agent", () => {
    expect(resolveAgentKey(mockManifest, "nonexistent")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(resolveAgentKey(mockManifest, "")).toBeNull();
  });

  it("should return null for cloud name (wrong kind)", () => {
    expect(resolveAgentKey(mockManifest, "sprite")).toBeNull();
  });
});

describe("resolveCloudKey (real export)", () => {
  it("should resolve exact key match", () => {
    expect(resolveCloudKey(mockManifest, "sprite")).toBe("sprite");
  });

  it("should resolve case-insensitive key match", () => {
    expect(resolveCloudKey(mockManifest, "Sprite")).toBe("sprite");
    expect(resolveCloudKey(mockManifest, "HETZNER")).toBe("hetzner");
  });

  it("should resolve by display name", () => {
    expect(resolveCloudKey(mockManifest, "Hetzner Cloud")).toBe("hetzner");
  });

  it("should resolve case-insensitive display name", () => {
    expect(resolveCloudKey(mockManifest, "hetzner cloud")).toBe("hetzner");
  });

  it("should return null for unknown cloud", () => {
    expect(resolveCloudKey(mockManifest, "nonexistent")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(resolveCloudKey(mockManifest, "")).toBeNull();
  });

  it("should return null for agent name (wrong kind)", () => {
    expect(resolveCloudKey(mockManifest, "claude")).toBeNull();
  });
});

// ── checkEntity ──────────────────────────────────────────────────────────────

describe("checkEntity (real export)", () => {
  // checkEntity calls p.log which requires clack/prompts mock - test basic cases

  it("should return true for valid agent", () => {
    expect(checkEntity(mockManifest, "claude", "agent")).toBe(true);
  });

  it("should return true for valid cloud", () => {
    expect(checkEntity(mockManifest, "sprite", "cloud")).toBe(true);
  });

  it("should return true for another valid agent", () => {
    expect(checkEntity(mockManifest, "aider", "agent")).toBe(true);
  });

  it("should return true for another valid cloud", () => {
    expect(checkEntity(mockManifest, "hetzner", "cloud")).toBe(true);
  });
});
