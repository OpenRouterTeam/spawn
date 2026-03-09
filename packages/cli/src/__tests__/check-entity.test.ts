import type { Manifest } from "../manifest";

import { beforeEach, describe, expect, it } from "bun:test";
import { checkEntity } from "../commands/index.js";

/**
 * Tests for checkEntity (commands/shared.ts).
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
 * This function is called in cmdRun (commands/run.ts) for both agent
 * and cloud validation, making it critical for the run pipeline.
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
        env: {
          ANTHROPIC_API_KEY: "test",
        },
      },
      codex: {
        name: "Codex",
        description: "AI pair programmer",
        url: "https://codex.dev",
        install: "npm install -g codex",
        launch: "codex",
        env: {
          OPENAI_API_KEY: "test",
        },
      },
      cline: {
        name: "Cline",
        description: "AI developer agent",
        url: "https://cline.dev",
        install: "npm install -g cline",
        launch: "cline",
        env: {},
      },
    },
    clouds: {
      sprite: {
        name: "Sprite",
        description: "Lightweight VMs",
        price: "test",
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
        price: "test",
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
        price: "test",
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
      "sprite/codex": "implemented",
      "sprite/cline": "missing",
      "hetzner/claude": "implemented",
      "hetzner/codex": "missing",
      "hetzner/cline": "missing",
      "vultr/claude": "implemented",
      "vultr/codex": "missing",
      "vultr/cline": "missing",
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

let manifest: Manifest;

describe("checkEntity", () => {
  beforeEach(() => {
    manifest = createTestManifest();
  });

  // ── Non-existent entities: no close match (distance > 3) ───────────────

  describe("non-existent entities with no close match", () => {
    const cases: Array<
      [
        string,
        "agent" | "cloud",
      ]
    > = [
      [
        "kubernetes",
        "agent",
      ],
      [
        "terraform",
        "agent",
      ],
      [
        "zzzzzzz",
        "agent",
      ],
      [
        "amazonaws",
        "cloud",
      ],
      [
        "googlecloud",
        "cloud",
      ],
      [
        "zzzzzzz",
        "cloud",
      ],
    ];
    for (const [input, kind] of cases) {
      it(`should return false for unknown ${kind} '${input}'`, () => {
        expect(checkEntity(manifest, input, kind)).toBe(false);
      });
    }
  });

  // ── Fuzzy match: close typos that should return false ──────────────────

  describe("fuzzy match for close typos", () => {
    const agentTypos = [
      "claud",
      "claudee",
      "codx",
      "codexs",
      "clin",
      "claue",
    ];
    const cloudTypos = [
      "sprit",
      "spritee",
      "hetzne",
      "vulr",
      "vultrr",
      "sprt",
    ];

    for (const typo of agentTypos) {
      it(`should return false for agent typo '${typo}'`, () => {
        expect(checkEntity(manifest, typo, "agent")).toBe(false);
      });
    }

    for (const typo of cloudTypos) {
      it(`should return false for cloud typo '${typo}'`, () => {
        expect(checkEntity(manifest, typo, "cloud")).toBe(false);
      });
    }
  });

  // ── Empty and boundary inputs ──────────────────────────────────────────

  describe("empty and boundary inputs", () => {
    const cases: Array<
      [
        string,
        "agent" | "cloud",
        string,
      ]
    > = [
      [
        "",
        "agent",
        "empty string as agent",
      ],
      [
        "",
        "cloud",
        "empty string as cloud",
      ],
      [
        "a",
        "agent",
        "single character agent",
      ],
      [
        "x",
        "cloud",
        "single character cloud",
      ],
      [
        "a".repeat(100),
        "agent",
        "very long input",
      ],
      [
        "claude-code",
        "agent",
        "input with hyphens",
      ],
      [
        "open_gptme",
        "agent",
        "input with underscores",
      ],
      [
        "123",
        "agent",
        "numeric input",
      ],
    ];
    for (const [input, kind, label] of cases) {
      it(`should return false for ${label}`, () => {
        expect(checkEntity(manifest, input, kind)).toBe(false);
      });
    }
  });

  // ── Edge cases with minimal manifest ───────────────────────────────────

  describe("minimal manifest edge cases", () => {
    it("should return false when agents collection is empty", () => {
      const emptyAgents: Manifest = {
        agents: {},
        clouds: {
          sprite: manifest.clouds.sprite,
        },
        matrix: {},
      };
      expect(checkEntity(emptyAgents, "claude", "agent")).toBe(false);
    });

    it("should return false when clouds collection is empty", () => {
      const emptyClouds: Manifest = {
        agents: {
          claude: manifest.agents.claude,
        },
        clouds: {},
        matrix: {},
      };
      expect(checkEntity(emptyClouds, "sprite", "cloud")).toBe(false);
    });

    it("should not crash on completely empty manifest", () => {
      const empty: Manifest = {
        agents: {},
        clouds: {},
        matrix: {},
      };
      expect(checkEntity(empty, "test", "agent")).toBe(false);
      expect(checkEntity(empty, "test", "cloud")).toBe(false);
    });

    it("should detect wrong type with single-entry collections", () => {
      const single: Manifest = {
        agents: {
          claude: manifest.agents.claude,
        },
        clouds: {
          sprite: manifest.clouds.sprite,
        },
        matrix: {},
      };
      // "sprite" exists in clouds but not agents
      expect(checkEntity(single, "sprite", "agent")).toBe(false);
      // "claude" exists in agents but not clouds
      expect(checkEntity(single, "claude", "cloud")).toBe(false);
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

  // ── Cross-kind fuzzy match: detect swapped args with typos ──────────

  describe("cross-kind fuzzy match for swapped args with typos", () => {
    const crossKindCases: Array<
      [
        string,
        "agent" | "cloud",
      ]
    > = [
      [
        "htzner",
        "agent",
      ], // close to cloud "hetzner"
      [
        "sprit",
        "agent",
      ], // close to cloud "sprite"
      [
        "vulr",
        "agent",
      ], // close to cloud "vultr"
      [
        "claud",
        "cloud",
      ], // close to agent "claude"
      [
        "codx",
        "cloud",
      ], // close to agent "codex"
      [
        "clin",
        "cloud",
      ], // close to agent "cline"
    ];
    for (const [typo, kind] of crossKindCases) {
      it(`should return false for '${typo}' as ${kind} (cross-kind typo)`, () => {
        expect(checkEntity(manifest, typo, kind)).toBe(false);
      });
    }

    it("should prefer same-kind match over cross-kind match", () => {
      expect(checkEntity(manifest, "cline", "agent")).toBe(true);
    });

    it("should not suggest cross-kind match for values far from any candidate", () => {
      expect(checkEntity(manifest, "zzzzzzz", "agent")).toBe(false);
      expect(checkEntity(manifest, "zzzzzzz", "cloud")).toBe(false);
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
            price: "test",
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
