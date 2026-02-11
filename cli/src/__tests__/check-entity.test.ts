import { describe, it, expect, beforeEach } from "bun:test";
import { checkEntity } from "../commands";
import type { Manifest } from "../manifest";

/**
 * Tests for checkEntity (commands.ts:182-206).
 *
 * checkEntity validates that a user-provided value exists in the manifest
 * as the expected entity kind (agent or cloud). It returns true if valid,
 * false otherwise. On failure it outputs error messages via @clack/prompts.
 *
 * Error branches:
 * 1. Wrong-type detection: user typed a cloud name where an agent was expected
 *    (or vice versa) -- returns false with specific guidance.
 * 2. Fuzzy match suggestion: user typed a close typo -- returns false with
 *    "Did you mean X?" suggestion.
 * 3. Generic error: no close match found -- returns false with list command hint.
 *
 * This function is called in cmdRun (commands.ts:396-397) for both agent
 * and cloud validation, making it critical for the run pipeline.
 *
 * Agent: test-engineer
 */

// ── Test Fixtures ──────────────────────────────────────────────────────────

function createTestManifest(): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: { ANTHROPIC_API_KEY: "test" },
      },
      aider: {
        name: "Aider",
        description: "AI pair programmer",
        url: "https://aider.chat",
        install: "pip install aider-chat",
        launch: "aider",
        env: { OPENAI_API_KEY: "test" },
      },
      goose: {
        name: "Goose",
        description: "AI developer agent",
        url: "https://goose.ai",
        install: "pip install goose",
        launch: "goose",
        env: {},
      },
    },
    clouds: {
      sprite: {
        name: "Sprite",
        description: "Lightweight VMs",
        url: "https://sprite.sh",
        type: "vm",
        auth: "SPRITE_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      hetzner: {
        name: "Hetzner Cloud",
        description: "European cloud provider",
        url: "https://hetzner.com",
        type: "cloud",
        auth: "HCLOUD_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      vultr: {
        name: "Vultr",
        description: "Cloud compute",
        url: "https://vultr.com",
        type: "cloud",
        auth: "VULTR_API_KEY",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/aider": "implemented",
      "sprite/goose": "missing",
      "hetzner/claude": "implemented",
      "hetzner/aider": "missing",
      "hetzner/goose": "missing",
      "vultr/claude": "implemented",
      "vultr/aider": "missing",
      "vultr/goose": "missing",
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

let manifest: Manifest;

describe("checkEntity", () => {
  beforeEach(() => {
    manifest = createTestManifest();
  });

  // ── Happy path: valid entities ──────────────────────────────────────────

  describe("valid entities", () => {
    it("should return true for agent key 'claude'", () => {
      expect(checkEntity(manifest, "claude", "agent")).toBe(true);
    });

    it("should return true for agent key 'aider'", () => {
      expect(checkEntity(manifest, "aider", "agent")).toBe(true);
    });

    it("should return true for agent key 'goose'", () => {
      expect(checkEntity(manifest, "goose", "agent")).toBe(true);
    });

    it("should return true for cloud key 'sprite'", () => {
      expect(checkEntity(manifest, "sprite", "cloud")).toBe(true);
    });

    it("should return true for cloud key 'hetzner'", () => {
      expect(checkEntity(manifest, "hetzner", "cloud")).toBe(true);
    });

    it("should return true for cloud key 'vultr'", () => {
      expect(checkEntity(manifest, "vultr", "cloud")).toBe(true);
    });

    it("should return true for all three agent keys", () => {
      for (const key of Object.keys(manifest.agents)) {
        expect(checkEntity(manifest, key, "agent")).toBe(true);
      }
    });
  });

  // ── Wrong-type detection: cloud given as agent ──────────────────────────

  describe("wrong-type detection: cloud given as agent", () => {
    it("should return false when 'sprite' is checked as agent", () => {
      expect(checkEntity(manifest, "sprite", "agent")).toBe(false);
    });

    it("should return false when 'hetzner' is checked as agent", () => {
      expect(checkEntity(manifest, "hetzner", "agent")).toBe(false);
    });

    it("should return false when 'vultr' is checked as agent", () => {
      expect(checkEntity(manifest, "vultr", "agent")).toBe(false);
    });

    it("should return false for all three cloud keys when checked as agent", () => {
      for (const key of Object.keys(manifest.clouds)) {
        expect(checkEntity(manifest, key, "agent")).toBe(false);
      }
    });
  });

  // ── Wrong-type detection: agent given as cloud ──────────────────────────

  describe("wrong-type detection: agent given as cloud", () => {
    it("should return false when 'claude' is checked as cloud", () => {
      expect(checkEntity(manifest, "claude", "cloud")).toBe(false);
    });

    it("should return false when 'aider' is checked as cloud", () => {
      expect(checkEntity(manifest, "aider", "cloud")).toBe(false);
    });

    it("should return false when 'goose' is checked as cloud", () => {
      expect(checkEntity(manifest, "goose", "cloud")).toBe(false);
    });

    it("should return false for all three agent keys when checked as cloud", () => {
      for (const key of Object.keys(manifest.agents)) {
        expect(checkEntity(manifest, key, "cloud")).toBe(false);
      }
    });
  });

  // ── Non-existent entities: no close match (distance > 3) ───────────────

  describe("non-existent entities with no close match", () => {
    it("should return false for completely unknown agent 'kubernetes'", () => {
      expect(checkEntity(manifest, "kubernetes", "agent")).toBe(false);
    });

    it("should return false for completely unknown cloud 'amazonaws'", () => {
      expect(checkEntity(manifest, "amazonaws", "cloud")).toBe(false);
    });

    it("should return false for unknown agent 'terraform'", () => {
      expect(checkEntity(manifest, "terraform", "agent")).toBe(false);
    });

    it("should return false for unknown cloud 'googlecloud'", () => {
      expect(checkEntity(manifest, "googlecloud", "cloud")).toBe(false);
    });

    it("should return false for strings far from any candidate", () => {
      expect(checkEntity(manifest, "zzzzzzz", "agent")).toBe(false);
      expect(checkEntity(manifest, "zzzzzzz", "cloud")).toBe(false);
    });
  });

  // ── Fuzzy match: close typos that should return false ──────────────────

  describe("fuzzy match for close typos", () => {
    it("should return false for 'claud' (typo of claude, distance 1)", () => {
      expect(checkEntity(manifest, "claud", "agent")).toBe(false);
    });

    it("should return false for 'claudee' (typo of claude, distance 1)", () => {
      expect(checkEntity(manifest, "claudee", "agent")).toBe(false);
    });

    it("should return false for 'aidr' (typo of aider, distance 1)", () => {
      expect(checkEntity(manifest, "aidr", "agent")).toBe(false);
    });

    it("should return false for 'aiders' (typo of aider, distance 1)", () => {
      expect(checkEntity(manifest, "aiders", "agent")).toBe(false);
    });

    it("should return false for 'goos' (typo of goose, distance 1)", () => {
      expect(checkEntity(manifest, "goos", "agent")).toBe(false);
    });

    it("should return false for 'sprit' (typo of sprite, distance 1)", () => {
      expect(checkEntity(manifest, "sprit", "cloud")).toBe(false);
    });

    it("should return false for 'spritee' (typo of sprite, distance 1)", () => {
      expect(checkEntity(manifest, "spritee", "cloud")).toBe(false);
    });

    it("should return false for 'hetzne' (typo of hetzner, distance 1)", () => {
      expect(checkEntity(manifest, "hetzne", "cloud")).toBe(false);
    });

    it("should return false for 'vulr' (typo of vultr, distance 1)", () => {
      expect(checkEntity(manifest, "vulr", "cloud")).toBe(false);
    });

    it("should return false for 'vultrr' (typo of vultr, distance 1)", () => {
      expect(checkEntity(manifest, "vultrr", "cloud")).toBe(false);
    });

    it("should return false for multi-character distance typos", () => {
      // "claue" has distance 2 from "claude" — still within threshold 3
      expect(checkEntity(manifest, "claue", "agent")).toBe(false);
      // "sprt" has distance 2 from "sprite"
      expect(checkEntity(manifest, "sprt", "cloud")).toBe(false);
    });
  });

  // ── Empty and boundary inputs ──────────────────────────────────────────

  describe("empty and boundary inputs", () => {
    it("should return false for empty string as agent", () => {
      expect(checkEntity(manifest, "", "agent")).toBe(false);
    });

    it("should return false for empty string as cloud", () => {
      expect(checkEntity(manifest, "", "cloud")).toBe(false);
    });

    it("should handle single character input without crashing", () => {
      expect(checkEntity(manifest, "a", "agent")).toBe(false);
    });

    it("should handle single character input for cloud without crashing", () => {
      expect(checkEntity(manifest, "x", "cloud")).toBe(false);
    });

    it("should handle very long input without crashing", () => {
      const longInput = "a".repeat(100);
      expect(checkEntity(manifest, longInput, "agent")).toBe(false);
    });

    it("should handle input with special characters", () => {
      expect(checkEntity(manifest, "claude-code", "agent")).toBe(false);
    });

    it("should handle input with underscores", () => {
      expect(checkEntity(manifest, "open_interpreter", "agent")).toBe(false);
    });

    it("should handle numeric input", () => {
      expect(checkEntity(manifest, "123", "agent")).toBe(false);
    });
  });

  // ── Edge cases with minimal manifest ───────────────────────────────────

  describe("minimal manifest edge cases", () => {
    it("should return false when agents collection is empty", () => {
      const emptyAgents: Manifest = {
        agents: {},
        clouds: { sprite: manifest.clouds.sprite },
        matrix: {},
      };
      expect(checkEntity(emptyAgents, "claude", "agent")).toBe(false);
    });

    it("should return false when clouds collection is empty", () => {
      const emptyClouds: Manifest = {
        agents: { claude: manifest.agents.claude },
        clouds: {},
        matrix: {},
      };
      expect(checkEntity(emptyClouds, "sprite", "cloud")).toBe(false);
    });

    it("should not crash on completely empty manifest (agent check)", () => {
      const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
      expect(checkEntity(empty, "test", "agent")).toBe(false);
    });

    it("should not crash on completely empty manifest (cloud check)", () => {
      const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
      expect(checkEntity(empty, "test", "cloud")).toBe(false);
    });

    it("should detect wrong type with single-entry collections", () => {
      const single: Manifest = {
        agents: { claude: manifest.agents.claude },
        clouds: { sprite: manifest.clouds.sprite },
        matrix: {},
      };
      // "sprite" exists in clouds but not agents
      expect(checkEntity(single, "sprite", "agent")).toBe(false);
      // "claude" exists in agents but not clouds
      expect(checkEntity(single, "claude", "cloud")).toBe(false);
    });
  });

  // ── Kind parameter consistency ──────────────────────────────────────────

  describe("kind parameter consistency", () => {
    it("should accept claude as agent but reject as cloud", () => {
      expect(checkEntity(manifest, "claude", "agent")).toBe(true);
      expect(checkEntity(manifest, "claude", "cloud")).toBe(false);
    });

    it("should accept aider as agent but reject as cloud", () => {
      expect(checkEntity(manifest, "aider", "agent")).toBe(true);
      expect(checkEntity(manifest, "aider", "cloud")).toBe(false);
    });

    it("should accept sprite as cloud but reject as agent", () => {
      expect(checkEntity(manifest, "sprite", "cloud")).toBe(true);
      expect(checkEntity(manifest, "sprite", "agent")).toBe(false);
    });

    it("should accept hetzner as cloud but reject as agent", () => {
      expect(checkEntity(manifest, "hetzner", "cloud")).toBe(true);
      expect(checkEntity(manifest, "hetzner", "agent")).toBe(false);
    });

    it("should accept vultr as cloud but reject as agent", () => {
      expect(checkEntity(manifest, "vultr", "cloud")).toBe(true);
      expect(checkEntity(manifest, "vultr", "agent")).toBe(false);
    });

    it("should accept goose as agent but reject as cloud", () => {
      expect(checkEntity(manifest, "goose", "agent")).toBe(true);
      expect(checkEntity(manifest, "goose", "cloud")).toBe(false);
    });
  });

  // ── All agents are valid when checked as agents ────────────────────────

  describe("all manifest agents validate correctly", () => {
    it("should validate every agent in the manifest", () => {
      const agentKeys = Object.keys(manifest.agents);
      for (const key of agentKeys) {
        expect(checkEntity(manifest, key, "agent")).toBe(true);
      }
    });

    it("should reject every agent key when checked as cloud", () => {
      const agentKeys = Object.keys(manifest.agents);
      for (const key of agentKeys) {
        expect(checkEntity(manifest, key, "cloud")).toBe(false);
      }
    });
  });

  // ── All clouds are valid when checked as clouds ────────────────────────

  describe("all manifest clouds validate correctly", () => {
    it("should validate every cloud in the manifest", () => {
      const cloudKeys = Object.keys(manifest.clouds);
      for (const key of cloudKeys) {
        expect(checkEntity(manifest, key, "cloud")).toBe(true);
      }
    });

    it("should reject every cloud key when checked as agent", () => {
      const cloudKeys = Object.keys(manifest.clouds);
      for (const key of cloudKeys) {
        expect(checkEntity(manifest, key, "agent")).toBe(false);
      }
    });
  });

  // ── Manifest with overlapping key names ────────────────────────────────

  describe("manifest with overlapping patterns", () => {
    it("should handle agent and cloud with similar names", () => {
      const overlapping: Manifest = {
        agents: {
          local: {
            name: "Local Agent",
            description: "Local agent",
            url: "",
            install: "",
            launch: "",
            env: {},
          },
        },
        clouds: {
          "local-cloud": {
            name: "Local Cloud",
            description: "Local cloud provider",
            url: "",
            type: "local",
            auth: "none",
            provision_method: "local",
            exec_method: "local",
            interactive_method: "local",
          },
        },
        matrix: {},
      };
      expect(checkEntity(overlapping, "local", "agent")).toBe(true);
      expect(checkEntity(overlapping, "local-cloud", "cloud")).toBe(true);
      expect(checkEntity(overlapping, "local", "cloud")).toBe(false);
      expect(checkEntity(overlapping, "local-cloud", "agent")).toBe(false);
    });
  });
});
