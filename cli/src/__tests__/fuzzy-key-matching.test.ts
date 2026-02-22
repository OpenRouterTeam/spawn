import { describe, it, expect } from "bun:test";
import {
  findClosestKeyByNameOrKey,
  levenshtein,
  findClosestMatch,
  resolveAgentKey,
  resolveCloudKey,
} from "../commands";
import { createMockManifest, } from "./test-helpers";

/**
 * Tests for findClosestKeyByNameOrKey — the fuzzy matching function that
 * checks both keys AND display names to find the best match for a typo.
 *
 * This function was added in PR #414 and is used in:
 * - validateAgent (commands.ts:177) — error suggestions for unknown agents
 * - validateCloud (commands.ts:206) — error suggestions for unknown clouds
 * - showInfoOrError (index.ts:112-113) — fallback suggestions for unknown commands
 *
 * It has a nuanced priority system:
 * 1. Check Levenshtein distance to each key
 * 2. Check Levenshtein distance to each display name (via getName callback)
 * 3. Return the key with the smallest distance (key or name), if <= 3
 *
 * This is distinct from findClosestMatch which only checks one list.
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── findClosestKeyByNameOrKey: basic key matching ────────────────────────────

describe("findClosestKeyByNameOrKey", () => {
  describe("key-based matching", () => {
    it("should match a key with distance 1 (missing letter)", () => {
      const keys = ["claude", "codex"];
      const result = findClosestKeyByNameOrKey("claud", keys, () => "irrelevant-name");
      expect(result).toBe("claude");
    });

    it("should match a key with distance 1 (extra letter)", () => {
      const keys = ["claude", "codex"];
      const result = findClosestKeyByNameOrKey("claudee", keys, () => "irrelevant-name");
      expect(result).toBe("claude");
    });

    it("should match a key with distance 1 (substitution)", () => {
      const keys = ["claude", "codex"];
      const result = findClosestKeyByNameOrKey("claudi", keys, () => "irrelevant-name");
      expect(result).toBe("claude");
    });

    it("should match a key with distance 2", () => {
      const keys = ["claude", "codex"];
      const result = findClosestKeyByNameOrKey("clad", keys, () => "irrelevant-name");
      expect(result).toBe("claude");
    });

    it("should match a key with distance 3 (max threshold)", () => {
      const keys = ["hetzner", "sprite"];
      const result = findClosestKeyByNameOrKey("hetz", keys, () => "irrelevant-name");
      expect(result).toBe("hetzner");
    });

    it("should return null when distance > 3 for all keys and names", () => {
      const keys = ["claude", "codex"];
      const result = findClosestKeyByNameOrKey(
        "kubernetes",
        keys,
        () => "irrelevant-name-that-is-also-far"
      );
      expect(result).toBeNull();
    });

    it("should be case-insensitive for key matching", () => {
      const keys = ["claude", "codex"];
      const result = findClosestKeyByNameOrKey("CLAUDE", keys, () => "irrelevant");
      expect(result).toBe("claude");
    });

    it("should pick the closest key among multiple close candidates", () => {
      const keys = ["codx", "codex", "codec"];
      const result = findClosestKeyByNameOrKey("codex", keys, () => "irrelevant");
      // Exact match (distance 0) should always win
      expect(result).toBe("codex");
    });
  });

  // ── display name matching ───────────────────────────────────────────────────

  describe("display name matching", () => {
    it("should match via display name when key is too far", () => {
      // Key "cc" is far from "claude-code", but name "Claude Code" is close
      const keys = ["cc"];
      const getName = (k: string) => (k === "cc" ? "Claude Code" : "Unknown");
      const result = findClosestKeyByNameOrKey("claude-code", keys, getName);
      // "claude-code" vs "Claude Code" -> lowercase: "claude-code" vs "claude code" -> distance 1
      expect(result).toBe("cc");
    });

    it("should match via display name with minor typo", () => {
      const keys = ["ap"];
      const getName = (k: string) => (k === "ap" ? "Codex Pro" : "Unknown");
      // "codex-pro" vs "codex pro" -> distance 1
      const result = findClosestKeyByNameOrKey("codex-pro", keys, getName);
      expect(result).toBe("ap");
    });

    it("should match via display name case-insensitively", () => {
      const keys = ["sp"];
      const getName = (k: string) => (k === "sp" ? "Sprite" : "Unknown");
      const result = findClosestKeyByNameOrKey("SPRITE", keys, getName);
      // "sprite" vs "sprite" -> distance 0
      expect(result).toBe("sp");
    });

    it("should return null when display name is also too far", () => {
      const keys = ["xy"];
      const getName = (k: string) => (k === "xy" ? "Extremely Long Different Name" : "Unknown");
      const result = findClosestKeyByNameOrKey("kubernetes", keys, getName);
      expect(result).toBeNull();
    });
  });

  // ── priority: key vs display name ─────────────────────────────────────────

  describe("priority between key and display name matches", () => {
    it("should prefer key when key distance < name distance", () => {
      const keys = ["sprite"];
      const getName = () => "Very Long Different Display Name";
      // "sprit" vs key "sprite" -> distance 1 (close)
      // "sprit" vs name "Very Long Different Display Name" -> distance >> 3
      const result = findClosestKeyByNameOrKey("sprit", keys, getName);
      expect(result).toBe("sprite");
    });

    it("should prefer name when name distance < key distance", () => {
      const keys = ["hz"];
      const getName = (k: string) => (k === "hz" ? "Hetzner" : "Unknown");
      // "hetzne" vs key "hz" -> distance 4 (too far for key alone)
      // "hetzne" vs name "Hetzner" -> distance 1
      const result = findClosestKeyByNameOrKey("hetzne", keys, getName);
      expect(result).toBe("hz");
    });

    it("should return key of best match even when match comes from display name", () => {
      const keys = ["a1", "b2"];
      const getName = (k: string) => {
        if (k === "a1") { return "Alpha Service"; }
        if (k === "b2") { return "Beta Cloud"; }
        return "Unknown";
      };
      // "beta-cloud" vs key "a1" -> distance 8, name "Alpha Service" -> distance >> 3
      // "beta-cloud" vs key "b2" -> distance 8, name "Beta Cloud" -> "beta-cloud" vs "beta cloud" -> distance 1
      const result = findClosestKeyByNameOrKey("beta-cloud", keys, getName);
      expect(result).toBe("b2");
    });

    it("should pick better match across keys when both key and name are close", () => {
      const keys = ["codx", "codex"];
      const getName = (k: string) => {
        if (k === "codx") { return "Codx Tool"; }
        if (k === "codex") { return "Codex"; }
        return "Unknown";
      };
      // "codex" vs key "codx" -> distance 1, name "Codx Tool" -> distance 5
      // "codex" vs key "codex" -> distance 0 (exact match via key)
      const result = findClosestKeyByNameOrKey("codex", keys, getName);
      expect(result).toBe("codex");
    });
  });

  // ── multiple keys: best overall match ────────────────────────────────────

  describe("multiple keys competition", () => {
    it("should pick closest among multiple keys", () => {
      const keys = ["claude", "clade", "claud"];
      const getName = () => "Irrelevant";
      // "claud" vs "claude" -> 1, vs "clade" -> 2, vs "claud" -> 0
      const result = findClosestKeyByNameOrKey("claud", keys, getName);
      expect(result).toBe("claud");
    });

    it("should pick closest via name when all keys are distant", () => {
      const keys = ["x1", "y2", "z3"];
      const getName = (k: string) => {
        if (k === "x1") { return "Alpha"; }
        if (k === "y2") { return "Betta"; // intentional typo for "Beta"
}
        if (k === "z3") { return "Gamma"; }
        return "Unknown";
      };
      // "beta" vs all keys -> distance >> 3
      // "beta" vs "Alpha" -> distance 4 (too far)
      // "beta" vs "Betta" -> distance 1
      // "beta" vs "Gamma" -> distance 4 (too far)
      const result = findClosestKeyByNameOrKey("beta", keys, getName);
      expect(result).toBe("y2");
    });

    it("should pick first key when two have equal distance", () => {
      const keys = ["ab", "ba"];
      const getName = () => "VeryDifferentName";
      // "aa" vs "ab" -> distance 1
      // "aa" vs "ba" -> distance 1
      // Both tied at distance 1, first one should win (bestDist starts at Infinity,
      // first match sets bestDist to 1, second match has distance 1 which is NOT < bestDist)
      const result = findClosestKeyByNameOrKey("aa", keys, getName);
      expect(result).toBe("ab");
    });
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should return null for empty keys array", () => {
      const result = findClosestKeyByNameOrKey("test", [], () => "Irrelevant");
      expect(result).toBeNull();
    });

    it("should handle exact key match (distance 0)", () => {
      const keys = ["claude"];
      const getName = () => "Claude Code";
      const result = findClosestKeyByNameOrKey("claude", keys, getName);
      expect(result).toBe("claude");
    });

    it("should handle exact display name match (distance 0)", () => {
      const keys = ["cc"];
      const getName = (k: string) => (k === "cc" ? "Test" : "Other");
      const result = findClosestKeyByNameOrKey("test", keys, getName);
      expect(result).toBe("cc");
    });

    it("should handle single character keys", () => {
      const keys = ["a", "b", "c"];
      const getName = () => "LongName";
      // "a" vs "a" -> 0, vs "b" -> 1, vs "c" -> 1
      const result = findClosestKeyByNameOrKey("a", keys, getName);
      expect(result).toBe("a");
    });

    it("should handle empty input string", () => {
      const keys = ["ab", "cd"];
      const getName = () => "Test";
      // "" vs "ab" -> 2, "" vs "cd" -> 2, "" vs "Test" -> 4
      const result = findClosestKeyByNameOrKey("", keys, getName);
      // distance 2 is <= 3, so "ab" (first match) should be returned
      expect(result).toBe("ab");
    });

    it("should handle getName returning empty string", () => {
      const keys = ["test"];
      const getName = () => "";
      // "tes" vs "test" -> distance 1
      // "tes" vs "" -> distance 3
      const result = findClosestKeyByNameOrKey("tes", keys, getName);
      expect(result).toBe("test");
    });
  });

  // ── integration with real manifest structure ──────────────────────────────

  describe("integration with manifest-like data", () => {
    const agentKeys = Object.keys(mockManifest.agents);
    const cloudKeys = Object.keys(mockManifest.clouds);
    const getAgentName = (k: string) => mockManifest.agents[k]?.name ?? "";
    const getCloudName = (k: string) => mockManifest.clouds[k]?.name ?? "";

    it("should find agent 'claude' for typo 'claud'", () => {
      const result = findClosestKeyByNameOrKey("claud", agentKeys, getAgentName);
      expect(result).toBe("claude");
    });

    it("should find agent 'codex' for typo 'codx'", () => {
      const result = findClosestKeyByNameOrKey("codx", agentKeys, getAgentName);
      expect(result).toBe("codex");
    });

    it("should find cloud 'sprite' for typo 'sprit'", () => {
      const result = findClosestKeyByNameOrKey("sprit", cloudKeys, getCloudName);
      expect(result).toBe("sprite");
    });

    it("should find cloud 'hetzner' for typo 'hetzne'", () => {
      const result = findClosestKeyByNameOrKey("hetzne", cloudKeys, getCloudName);
      expect(result).toBe("hetzner");
    });

    it("should find agent 'claude' via display name 'Claude Code' typo", () => {
      // "claude-code" -> key "claude" distance 5 (too far), name "Claude Code" -> "claude-code" vs "claude code" -> 1
      const result = findClosestKeyByNameOrKey("claude-code", agentKeys, getAgentName);
      expect(result).toBe("claude");
    });

    it("should return null for completely unrelated input", () => {
      const result = findClosestKeyByNameOrKey("kubernetes", agentKeys, getAgentName);
      expect(result).toBeNull();
    });
  });
});

// ── levenshtein: boundary and regression tests ──────────────────────────────

describe("levenshtein - additional boundary tests", () => {
  it("should return 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("should return 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("should return length of non-empty string when other is empty", () => {
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "xyz")).toBe(3);
  });

  it("should be symmetric", () => {
    expect(levenshtein("kitten", "sitting")).toBe(levenshtein("sitting", "kitten"));
    expect(levenshtein("abc", "xyz")).toBe(levenshtein("xyz", "abc"));
  });

  it("should correctly compute known distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("saturday", "sunday")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
  });

  it("should handle single character differences", () => {
    // Substitution
    expect(levenshtein("a", "b")).toBe(1);
    // Insertion
    expect(levenshtein("a", "ab")).toBe(1);
    // Deletion
    expect(levenshtein("ab", "a")).toBe(1);
  });

  it("should handle completely different strings", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("should handle case differences (case-sensitive)", () => {
    expect(levenshtein("ABC", "abc")).toBe(3);
  });
});

// ── findClosestMatch: ensure threshold boundary ─────────────────────────────

describe("findClosestMatch - threshold boundary tests", () => {
  const candidates = ["claude", "codex", "sprite", "hetzner"];

  it("should match at exactly distance 3", () => {
    // "clau" -> "claude" distance 2, within threshold
    const result = findClosestMatch("clau", candidates);
    expect(result).toBe("claude");
  });

  it("should not match at distance 4", () => {
    // Need a string that is distance 4+ from all candidates
    // "zzzzz" vs "claude" -> 6, "codex" -> 5, "sprite" -> 6, "hetzner" -> 7
    const result = findClosestMatch("zzzzz", candidates);
    expect(result).toBeNull();
  });

  it("should match at distance 0 (exact match)", () => {
    const result = findClosestMatch("claude", candidates);
    expect(result).toBe("claude");
  });

  it("should match at distance 1", () => {
    const result = findClosestMatch("claud", candidates);
    expect(result).toBe("claude");
  });

  it("should match at distance 2", () => {
    const result = findClosestMatch("clau", candidates);
    expect(result).toBe("claude");
  });

  it("should return the closest when multiple are within threshold", () => {
    // "codx" is distance 1 from "codex" and distance 5 from "claude"
    const result = findClosestMatch("codx", candidates);
    expect(result).toBe("codex");
  });

  it("should handle empty candidates", () => {
    expect(findClosestMatch("test", [])).toBeNull();
  });

  it("should handle empty input", () => {
    // "" vs candidates: "claude"(6), "codex"(5), "sprite"(6), "hetzner"(7)
    // All > 3, so should return null
    const result = findClosestMatch("", candidates);
    expect(result).toBeNull();
  });

  it("should be case-insensitive", () => {
    const result = findClosestMatch("CLAUDE", candidates);
    expect(result).toBe("claude");
  });

  it("should match with single character candidates", () => {
    // "a" distance from "a" is 0
    const result = findClosestMatch("a", ["a", "b", "c"]);
    expect(result).toBe("a");
  });
});

// ── resolveAgentKey / resolveCloudKey: display name edge cases ──────────────

describe("resolveAgentKey - display name edge cases", () => {
  it("should resolve case-insensitive display name match", () => {
    // "claude code" matches display name "Claude Code" case-insensitively
    expect(resolveAgentKey(mockManifest, "claude code")).toBe("claude");
  });

  it("should prefer exact key match over display name match", () => {
    // If key is "claude" and display name is "Claude Code",
    // input "claude" should match as key (exact), not try display names
    expect(resolveAgentKey(mockManifest, "claude")).toBe("claude");
  });

  it("should try case-insensitive key before display name", () => {
    // "CLAUDE" should match key "claude" case-insensitively
    // before trying display name matching
    expect(resolveAgentKey(mockManifest, "CLAUDE")).toBe("claude");
  });

  it("should return null for non-matching input", () => {
    expect(resolveAgentKey(mockManifest, "nonexistent")).toBeNull();
  });
});

describe("resolveCloudKey - display name edge cases", () => {
  it("should resolve case-insensitive display name match", () => {
    expect(resolveCloudKey(mockManifest, "hetzner cloud")).toBe("hetzner");
  });

  it("should prefer exact key match over display name match", () => {
    expect(resolveCloudKey(mockManifest, "sprite")).toBe("sprite");
  });

  it("should try case-insensitive key before display name", () => {
    expect(resolveCloudKey(mockManifest, "SPRITE")).toBe("sprite");
  });

  it("should return null for non-matching input", () => {
    expect(resolveCloudKey(mockManifest, "nonexistent")).toBeNull();
  });
});
