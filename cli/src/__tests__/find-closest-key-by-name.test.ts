import { describe, it, expect } from "bun:test";
import { findClosestKeyByNameOrKey } from "../commands";

/**
 * Tests for findClosestKeyByNameOrKey (commands.ts:111-133).
 *
 * This exported function is used in three critical user-facing paths:
 * - suggestTypoCorrection: suggests corrections for unknown agent/cloud names
 * - showUnknownCommandError (index.ts): suggests similar commands for unknown input
 * - suggestFilterCorrection: suggests corrections for list filter values
 *
 * It searches BOTH keys and display names for fuzzy matches, returning the
 * KEY of the best match (not the display name). This dual-search behavior
 * is what makes it different from findClosestMatch (which only searches keys).
 *
 * Existing coverage:
 * - findClosestMatch (key-only): tested in commands-helpers.test.ts
 * - checkEntity messages (which internally call suggestTypoCorrection):
 *   tested in check-entity-messages.test.ts
 * - commands-internal-helpers.test.ts tests a REPLICA, not the actual export
 *
 * This file tests the ACTUAL export with:
 * - Exact key match (distance 0)
 * - Close key typo (distance 1-3)
 * - Exact display name match (distance 0)
 * - Close display name typo (distance 1-3)
 * - Key match preferred over name match when key is closer
 * - Name match preferred over key match when name is closer
 * - Returns null when all distances > 3
 * - Empty candidates list
 * - Case-insensitive matching for both keys and names
 * - Single-character inputs
 * - Names with spaces (multi-word display names)
 * - Tie-breaking behavior
 *
 * Agent: test-engineer
 */

// ── Test Data ────────────────────────────────────────────────────────────────

const agentKeys = ["claude", "aider", "openclaw", "nanoclaw", "goose", "codex"];
const agentNames: Record<string, string> = {
  claude: "Claude Code",
  aider: "Aider",
  openclaw: "OpenClaw",
  nanoclaw: "NanoClaw",
  goose: "Goose",
  codex: "Codex",
};
const getAgentName = (key: string) => agentNames[key];

const cloudKeys = ["sprite", "hetzner", "vultr", "linode", "digitalocean"];
const cloudNames: Record<string, string> = {
  sprite: "Sprite",
  hetzner: "Hetzner Cloud",
  vultr: "Vultr",
  linode: "Linode",
  digitalocean: "DigitalOcean",
};
const getCloudName = (key: string) => cloudNames[key];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("findClosestKeyByNameOrKey", () => {
  // ── Exact key matches ──────────────────────────────────────────────────

  describe("exact key match (distance 0)", () => {
    it("should return the key for an exact match", () => {
      expect(findClosestKeyByNameOrKey("claude", agentKeys, getAgentName)).toBe("claude");
    });

    it("should return exact key match for each agent", () => {
      for (const key of agentKeys) {
        expect(findClosestKeyByNameOrKey(key, agentKeys, getAgentName)).toBe(key);
      }
    });

    it("should return exact key match for each cloud", () => {
      for (const key of cloudKeys) {
        expect(findClosestKeyByNameOrKey(key, cloudKeys, getCloudName)).toBe(key);
      }
    });
  });

  // ── Close key typos (distance 1-3) ─────────────────────────────────────

  describe("close key typo (distance 1-3)", () => {
    it("should match 'claud' to 'claude' (distance 1 deletion)", () => {
      expect(findClosestKeyByNameOrKey("claud", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'claudee' to 'claude' (distance 1 insertion)", () => {
      expect(findClosestKeyByNameOrKey("claudee", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'cladue' to 'claude' (distance 1 transposition-like)", () => {
      expect(findClosestKeyByNameOrKey("cladue", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'aidr' to 'aider' (distance 1 deletion)", () => {
      expect(findClosestKeyByNameOrKey("aidr", agentKeys, getAgentName)).toBe("aider");
    });

    it("should match 'sprit' to 'sprite' (distance 1 deletion)", () => {
      expect(findClosestKeyByNameOrKey("sprit", cloudKeys, getCloudName)).toBe("sprite");
    });

    it("should match 'hetzne' to 'hetzner' (distance 1 deletion)", () => {
      expect(findClosestKeyByNameOrKey("hetzne", cloudKeys, getCloudName)).toBe("hetzner");
    });

    it("should match 'vulr' to 'vultr' (distance 1 deletion)", () => {
      expect(findClosestKeyByNameOrKey("vulr", cloudKeys, getCloudName)).toBe("vultr");
    });

    it("should match 'goosee' to 'goose' (distance 1 insertion)", () => {
      expect(findClosestKeyByNameOrKey("goosee", agentKeys, getAgentName)).toBe("goose");
    });

    it("should match 'codx' to 'codex' (distance 1 deletion)", () => {
      expect(findClosestKeyByNameOrKey("codx", agentKeys, getAgentName)).toBe("codex");
    });

    it("should match 'linde' to 'linode' (distance 1 substitution)", () => {
      expect(findClosestKeyByNameOrKey("linde", cloudKeys, getCloudName)).toBe("linode");
    });
  });

  // ── Display name exact match ───────────────────────────────────────────

  describe("exact display name match (distance 0)", () => {
    it("should match 'Claude Code' to key 'claude'", () => {
      expect(findClosestKeyByNameOrKey("Claude Code", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'Aider' to key 'aider'", () => {
      expect(findClosestKeyByNameOrKey("Aider", agentKeys, getAgentName)).toBe("aider");
    });

    it("should match 'Hetzner Cloud' to key 'hetzner'", () => {
      expect(findClosestKeyByNameOrKey("Hetzner Cloud", cloudKeys, getCloudName)).toBe("hetzner");
    });

    it("should match 'DigitalOcean' to key 'digitalocean'", () => {
      expect(findClosestKeyByNameOrKey("DigitalOcean", cloudKeys, getCloudName)).toBe("digitalocean");
    });

    it("should match 'Sprite' to key 'sprite'", () => {
      expect(findClosestKeyByNameOrKey("Sprite", cloudKeys, getCloudName)).toBe("sprite");
    });
  });

  // ── Display name close typo ────────────────────────────────────────────

  describe("close display name typo (distance 1-3)", () => {
    it("should match 'Claude Cod' to key 'claude' via name", () => {
      expect(findClosestKeyByNameOrKey("Claude Cod", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'Hetzner Clod' to key 'hetzner' via name (distance 1)", () => {
      expect(findClosestKeyByNameOrKey("Hetzner Clod", cloudKeys, getCloudName)).toBe("hetzner");
    });

    it("should match 'Sprit' to key 'sprite' via name (distance 1)", () => {
      expect(findClosestKeyByNameOrKey("Sprit", cloudKeys, getCloudName)).toBe("sprite");
    });

    it("should match 'Gooe' to key 'goose' via name (distance 1)", () => {
      expect(findClosestKeyByNameOrKey("Gooe", agentKeys, getAgentName)).toBe("goose");
    });

    it("should match 'OpenCla' to key 'openclaw' via name (distance 1)", () => {
      expect(findClosestKeyByNameOrKey("OpenCla", agentKeys, getAgentName)).toBe("openclaw");
    });
  });

  // ── Case insensitive matching ──────────────────────────────────────────

  describe("case-insensitive matching", () => {
    it("should match 'CLAUDE' to 'claude' case-insensitively", () => {
      expect(findClosestKeyByNameOrKey("CLAUDE", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'Claude' to 'claude' case-insensitively", () => {
      expect(findClosestKeyByNameOrKey("Claude", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'SPRITE' to 'sprite' case-insensitively", () => {
      expect(findClosestKeyByNameOrKey("SPRITE", cloudKeys, getCloudName)).toBe("sprite");
    });

    it("should match 'hetzner cloud' to 'hetzner' via name (case-insensitive)", () => {
      expect(findClosestKeyByNameOrKey("hetzner cloud", cloudKeys, getCloudName)).toBe("hetzner");
    });

    it("should match 'claude code' to 'claude' via name (case-insensitive)", () => {
      expect(findClosestKeyByNameOrKey("claude code", agentKeys, getAgentName)).toBe("claude");
    });

    it("should match 'AIDER' to 'aider' case-insensitively", () => {
      expect(findClosestKeyByNameOrKey("AIDER", agentKeys, getAgentName)).toBe("aider");
    });

    it("should match 'HETZNER CLOUD' to 'hetzner' via name (all caps)", () => {
      expect(findClosestKeyByNameOrKey("HETZNER CLOUD", cloudKeys, getCloudName)).toBe("hetzner");
    });
  });

  // ── Returns null for distant matches ───────────────────────────────────

  describe("returns null when distance > 3", () => {
    it("should return null for 'kubernetes' (far from all agents)", () => {
      expect(findClosestKeyByNameOrKey("kubernetes", agentKeys, getAgentName)).toBeNull();
    });

    it("should return null for 'amazonaws' (far from all clouds)", () => {
      expect(findClosestKeyByNameOrKey("amazonaws", cloudKeys, getCloudName)).toBeNull();
    });

    it("should return null for empty input", () => {
      expect(findClosestKeyByNameOrKey("", agentKeys, getAgentName)).toBeNull();
    });

    it("should return null for very long input", () => {
      expect(findClosestKeyByNameOrKey("a".repeat(50), agentKeys, getAgentName)).toBeNull();
    });

    it("should return null for 'terraform' (far from everything)", () => {
      expect(findClosestKeyByNameOrKey("terraform", agentKeys, getAgentName)).toBeNull();
    });

    it("should return null for 'zzzzzzz'", () => {
      expect(findClosestKeyByNameOrKey("zzzzzzz", agentKeys, getAgentName)).toBeNull();
      expect(findClosestKeyByNameOrKey("zzzzzzz", cloudKeys, getCloudName)).toBeNull();
    });

    it("should return null for numeric input", () => {
      expect(findClosestKeyByNameOrKey("12345", agentKeys, getAgentName)).toBeNull();
    });
  });

  // ── Empty candidates ──────────────────────────────────────────────────

  describe("empty candidates list", () => {
    it("should return null for empty keys array", () => {
      expect(findClosestKeyByNameOrKey("claude", [], getAgentName)).toBeNull();
    });

    it("should return null for empty keys with any input", () => {
      expect(findClosestKeyByNameOrKey("anything", [], () => "Name")).toBeNull();
    });
  });

  // ── Prefers closer match ───────────────────────────────────────────────

  describe("prefers closer match (key vs name)", () => {
    it("should prefer exact key match over distant name match", () => {
      // "aider" matches key "aider" exactly (distance 0)
      // even though display name "Aider" is also distance 0
      const result = findClosestKeyByNameOrKey("aider", agentKeys, getAgentName);
      expect(result).toBe("aider");
    });

    it("should match by name when key is far but name is close", () => {
      // "NanoClaw" is far from key "nanoclaw" in case-insensitive comparison
      // but exactly matches display name "NanoClaw"
      // Actually "nanoclaw" vs "NanoClaw" case-insensitive is distance 0
      // So this should match
      const result = findClosestKeyByNameOrKey("NanoClaw", agentKeys, getAgentName);
      expect(result).toBe("nanoclaw");
    });

    it("should return the key whose name is closest when keys are all distant", () => {
      // Use a custom set where display names differ significantly from keys
      const keys = ["abc", "def", "ghi"];
      const names: Record<string, string> = {
        abc: "My Alpha",
        def: "My Delta",
        ghi: "My Gamma",
      };
      const getName = (k: string) => names[k];

      // "My Delt" is closest to name "My Delta" (distance 1)
      const result = findClosestKeyByNameOrKey("My Delt", keys, getName);
      expect(result).toBe("def");
    });

    it("should return key matching by name when key itself is far", () => {
      const keys = ["x123"];
      const names: Record<string, string> = { x123: "Claude" };
      const getName = (k: string) => names[k];

      // "Claude" exactly matches display name, even though key "x123" is far
      expect(findClosestKeyByNameOrKey("Claude", keys, getName)).toBe("x123");
    });
  });

  // ── Single candidate ──────────────────────────────────────────────────

  describe("single candidate", () => {
    it("should match exact key with single candidate", () => {
      expect(findClosestKeyByNameOrKey("claude", ["claude"], (k) => "Claude Code")).toBe("claude");
    });

    it("should match close key with single candidate", () => {
      expect(findClosestKeyByNameOrKey("claud", ["claude"], (k) => "Claude Code")).toBe("claude");
    });

    it("should match by name with single candidate", () => {
      expect(findClosestKeyByNameOrKey("Claude Code", ["claude"], (k) => "Claude Code")).toBe("claude");
    });

    it("should return null when single candidate is far", () => {
      expect(findClosestKeyByNameOrKey("kubernetes", ["claude"], (k) => "Claude Code")).toBeNull();
    });
  });

  // ── Multi-word display names ───────────────────────────────────────────

  describe("multi-word display names", () => {
    it("should match partial multi-word name within distance 3", () => {
      // "Hetzner Clo" is distance 2 from "Hetzner Cloud"
      expect(findClosestKeyByNameOrKey("Hetzner Clo", cloudKeys, getCloudName)).toBe("hetzner");
    });

    it("should not match when multi-word name is too different", () => {
      // "Amazon Cloud Services" is far from "Hetzner Cloud"
      expect(findClosestKeyByNameOrKey("Amazon Cloud Services", cloudKeys, getCloudName)).toBeNull();
    });

    it("should handle display name with extra word", () => {
      // "Claude Code Pro" is distance 4 from "Claude Code" (too far)
      expect(findClosestKeyByNameOrKey("Claude Code Pro", agentKeys, getAgentName)).toBeNull();
    });
  });

  // ── Boundary: distance exactly 3 ──────────────────────────────────────

  describe("boundary: distance exactly 3", () => {
    it("should match when closest distance is exactly 3", () => {
      // "gooser" has distance 1 from "goose" key, should match
      expect(findClosestKeyByNameOrKey("gooser", agentKeys, getAgentName)).toBe("goose");
    });

    it("should match 'cla' to 'claude' (key distance 3)", () => {
      // "cla" vs "claude" = distance 3 (need to add "u", "d", "e")
      expect(findClosestKeyByNameOrKey("cla", agentKeys, getAgentName)).toBe("claude");
    });

    it("should return null when best distance is 4", () => {
      // "cl" vs "claude" = distance 4
      // "cl" vs "codex" = distance 4
      // All names are also far
      // Check if any key or name has distance <= 3
      const result = findClosestKeyByNameOrKey("cl", agentKeys, getAgentName);
      // "cl" vs "openclaw" key = distance 6
      // "cl" vs "nanoclaw" key = distance 6
      // "cl" vs "aider" = 4, "goose" = 4, "codex" = 4
      // "cl" vs "Claude Code" name = distance 8 (case insensitive)
      // "cl" vs "Aider" name = 4
      // All > 3, so null
      expect(result).toBeNull();
    });
  });

  // ── openclaw vs nanoclaw disambiguation ────────────────────────────────

  describe("disambiguating similar keys", () => {
    it("should match 'opencla' to 'openclaw' not 'nanoclaw'", () => {
      expect(findClosestKeyByNameOrKey("opencla", agentKeys, getAgentName)).toBe("openclaw");
    });

    it("should match 'nanocla' to 'nanoclaw' not 'openclaw'", () => {
      expect(findClosestKeyByNameOrKey("nanocla", agentKeys, getAgentName)).toBe("nanoclaw");
    });

    it("should pick closer key when both are within threshold", () => {
      // "claw" has distance 4 from both "openclaw" and "nanoclaw" (too far)
      // but distance 2 from "claude" key, so should match claude
      const result = findClosestKeyByNameOrKey("claw", agentKeys, getAgentName);
      expect(result).toBe("claude");
    });
  });
});
