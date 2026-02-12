import { describe, it, expect } from "bun:test";
import { resolveAgentKey, resolveCloudKey } from "../commands";
import type { Manifest } from "../manifest";

/**
 * Direct unit tests for resolveAgentKey and resolveCloudKey (commands.ts).
 *
 * These functions are the primary resolution layer for user-provided agent
 * and cloud names. They implement a 3-stage lookup:
 *   1. Exact key match (e.g., "claude" -> "claude")
 *   2. Case-insensitive key match (e.g., "CLAUDE" -> "claude")
 *   3. Display name match, case-insensitive (e.g., "Claude Code" -> "claude")
 *
 * They are used by cmdRun, cmdList, showInfoOrError, and resolveListFilters,
 * making them critical to the CLI's user-facing resolution pipeline.
 *
 * Previously only tested indirectly through cmdRun integration tests.
 * This file tests the resolution logic directly on the exported functions.
 *
 * Agent: test-engineer
 */

// ── Test Fixtures ────────────────────────────────────────────────────────────

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
      "open-interpreter": {
        name: "Open Interpreter",
        description: "Natural language interface",
        url: "https://openinterpreter.com",
        install: "pip install open-interpreter",
        launch: "interpreter",
        env: {},
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
      "digital-ocean": {
        name: "DigitalOcean",
        description: "Cloud platform",
        url: "https://digitalocean.com",
        type: "cloud",
        auth: "DO_API_TOKEN",
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
      "hetzner/claude": "implemented",
      "hetzner/aider": "missing",
      "digital-ocean/claude": "implemented",
      "vultr/claude": "implemented",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// resolveAgentKey
// ═══════════════════════════════════════════════════════════════════════════════

describe("resolveAgentKey", () => {
  const manifest = createTestManifest();

  // ── Stage 1: exact key match ────────────────────────────────────────────

  describe("exact key match", () => {
    it("should resolve 'claude' to 'claude'", () => {
      expect(resolveAgentKey(manifest, "claude")).toBe("claude");
    });

    it("should resolve 'aider' to 'aider'", () => {
      expect(resolveAgentKey(manifest, "aider")).toBe("aider");
    });

    it("should resolve 'open-interpreter' to 'open-interpreter'", () => {
      expect(resolveAgentKey(manifest, "open-interpreter")).toBe("open-interpreter");
    });

    it("should resolve 'goose' to 'goose'", () => {
      expect(resolveAgentKey(manifest, "goose")).toBe("goose");
    });

    it("should resolve all agent keys via exact match", () => {
      for (const key of Object.keys(manifest.agents)) {
        expect(resolveAgentKey(manifest, key)).toBe(key);
      }
    });
  });

  // ── Stage 2: case-insensitive key match ─────────────────────────────────

  describe("case-insensitive key match", () => {
    it("should resolve 'CLAUDE' to 'claude'", () => {
      expect(resolveAgentKey(manifest, "CLAUDE")).toBe("claude");
    });

    it("should resolve 'Claude' to 'claude'", () => {
      expect(resolveAgentKey(manifest, "Claude")).toBe("claude");
    });

    it("should resolve 'AIDER' to 'aider'", () => {
      expect(resolveAgentKey(manifest, "AIDER")).toBe("aider");
    });

    it("should resolve 'Aider' to 'aider'", () => {
      expect(resolveAgentKey(manifest, "Aider")).toBe("aider");
    });

    it("should resolve 'GOOSE' to 'goose'", () => {
      expect(resolveAgentKey(manifest, "GOOSE")).toBe("goose");
    });

    it("should resolve 'Open-Interpreter' to 'open-interpreter'", () => {
      expect(resolveAgentKey(manifest, "Open-Interpreter")).toBe("open-interpreter");
    });

    it("should resolve 'OPEN-INTERPRETER' to 'open-interpreter'", () => {
      expect(resolveAgentKey(manifest, "OPEN-INTERPRETER")).toBe("open-interpreter");
    });
  });

  // ── Stage 3: display name match (case-insensitive) ──────────────────────

  describe("display name match", () => {
    it("should resolve 'Claude Code' (exact display name) to 'claude'", () => {
      expect(resolveAgentKey(manifest, "Claude Code")).toBe("claude");
    });

    it("should resolve 'claude code' (lowercase display name) to 'claude'", () => {
      expect(resolveAgentKey(manifest, "claude code")).toBe("claude");
    });

    it("should resolve 'CLAUDE CODE' (uppercase display name) to 'claude'", () => {
      expect(resolveAgentKey(manifest, "CLAUDE CODE")).toBe("claude");
    });

    it("should resolve 'Open Interpreter' (display name) to 'open-interpreter'", () => {
      expect(resolveAgentKey(manifest, "Open Interpreter")).toBe("open-interpreter");
    });

    it("should resolve 'open interpreter' (lowercase display name) to 'open-interpreter'", () => {
      expect(resolveAgentKey(manifest, "open interpreter")).toBe("open-interpreter");
    });

    it("should resolve 'Goose' (display name same as key except case) to 'goose'", () => {
      // "Goose" matches key case-insensitively in stage 2, so it resolves there
      expect(resolveAgentKey(manifest, "Goose")).toBe("goose");
    });
  });

  // ── No match ────────────────────────────────────────────────────────────

  describe("no match", () => {
    it("should return null for completely unknown agent", () => {
      expect(resolveAgentKey(manifest, "kubernetes")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(resolveAgentKey(manifest, "")).toBeNull();
    });

    it("should return null for cloud key used as agent", () => {
      expect(resolveAgentKey(manifest, "sprite")).toBeNull();
    });

    it("should return null for cloud display name used as agent", () => {
      expect(resolveAgentKey(manifest, "Hetzner Cloud")).toBeNull();
    });

    it("should return null for partial key match", () => {
      expect(resolveAgentKey(manifest, "clau")).toBeNull();
    });

    it("should return null for misspelled agent name", () => {
      expect(resolveAgentKey(manifest, "claudee code")).toBeNull();
    });

    it("should return null for agent key with extra characters", () => {
      expect(resolveAgentKey(manifest, "claude-code")).toBeNull();
    });
  });

  // ── Priority: exact key > case-insensitive key > display name ───────────

  describe("resolution priority", () => {
    it("should prefer exact key over case-insensitive match", () => {
      // "claude" is an exact match, should not go to case-insensitive
      const result = resolveAgentKey(manifest, "claude");
      expect(result).toBe("claude");
    });

    it("should prefer case-insensitive key over display name", () => {
      // "Aider" matches case-insensitively as key "aider" (stage 2)
      // It also matches display name "Aider" (stage 3)
      // Stage 2 should win
      const result = resolveAgentKey(manifest, "Aider");
      expect(result).toBe("aider");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveCloudKey
// ═══════════════════════════════════════════════════════════════════════════════

describe("resolveCloudKey", () => {
  const manifest = createTestManifest();

  // ── Stage 1: exact key match ────────────────────────────────────────────

  describe("exact key match", () => {
    it("should resolve 'sprite' to 'sprite'", () => {
      expect(resolveCloudKey(manifest, "sprite")).toBe("sprite");
    });

    it("should resolve 'hetzner' to 'hetzner'", () => {
      expect(resolveCloudKey(manifest, "hetzner")).toBe("hetzner");
    });

    it("should resolve 'digital-ocean' to 'digital-ocean'", () => {
      expect(resolveCloudKey(manifest, "digital-ocean")).toBe("digital-ocean");
    });

    it("should resolve 'vultr' to 'vultr'", () => {
      expect(resolveCloudKey(manifest, "vultr")).toBe("vultr");
    });

    it("should resolve all cloud keys via exact match", () => {
      for (const key of Object.keys(manifest.clouds)) {
        expect(resolveCloudKey(manifest, key)).toBe(key);
      }
    });
  });

  // ── Stage 2: case-insensitive key match ─────────────────────────────────

  describe("case-insensitive key match", () => {
    it("should resolve 'SPRITE' to 'sprite'", () => {
      expect(resolveCloudKey(manifest, "SPRITE")).toBe("sprite");
    });

    it("should resolve 'Sprite' to 'sprite'", () => {
      expect(resolveCloudKey(manifest, "Sprite")).toBe("sprite");
    });

    it("should resolve 'HETZNER' to 'hetzner'", () => {
      expect(resolveCloudKey(manifest, "HETZNER")).toBe("hetzner");
    });

    it("should resolve 'Hetzner' to 'hetzner'", () => {
      expect(resolveCloudKey(manifest, "Hetzner")).toBe("hetzner");
    });

    it("should resolve 'VULTR' to 'vultr'", () => {
      expect(resolveCloudKey(manifest, "VULTR")).toBe("vultr");
    });

    it("should resolve 'Digital-Ocean' to 'digital-ocean'", () => {
      expect(resolveCloudKey(manifest, "Digital-Ocean")).toBe("digital-ocean");
    });

    it("should resolve 'DIGITAL-OCEAN' to 'digital-ocean'", () => {
      expect(resolveCloudKey(manifest, "DIGITAL-OCEAN")).toBe("digital-ocean");
    });
  });

  // ── Stage 3: display name match (case-insensitive) ──────────────────────

  describe("display name match", () => {
    it("should resolve 'Hetzner Cloud' (exact display name) to 'hetzner'", () => {
      expect(resolveCloudKey(manifest, "Hetzner Cloud")).toBe("hetzner");
    });

    it("should resolve 'hetzner cloud' (lowercase display name) to 'hetzner'", () => {
      expect(resolveCloudKey(manifest, "hetzner cloud")).toBe("hetzner");
    });

    it("should resolve 'HETZNER CLOUD' (uppercase display name) to 'hetzner'", () => {
      expect(resolveCloudKey(manifest, "HETZNER CLOUD")).toBe("hetzner");
    });

    it("should resolve 'DigitalOcean' (display name) to 'digital-ocean'", () => {
      expect(resolveCloudKey(manifest, "DigitalOcean")).toBe("digital-ocean");
    });

    it("should resolve 'digitalocean' (lowercase display name) to 'digital-ocean'", () => {
      expect(resolveCloudKey(manifest, "digitalocean")).toBe("digital-ocean");
    });

    it("should resolve 'DIGITALOCEAN' (uppercase display name) to 'digital-ocean'", () => {
      expect(resolveCloudKey(manifest, "DIGITALOCEAN")).toBe("digital-ocean");
    });

    it("should resolve 'Vultr' via case-insensitive key (stage 2, not display name)", () => {
      // "Vultr" matches key "vultr" case-insensitively, should resolve in stage 2
      expect(resolveCloudKey(manifest, "Vultr")).toBe("vultr");
    });
  });

  // ── No match ────────────────────────────────────────────────────────────

  describe("no match", () => {
    it("should return null for completely unknown cloud", () => {
      expect(resolveCloudKey(manifest, "amazonaws")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(resolveCloudKey(manifest, "")).toBeNull();
    });

    it("should return null for agent key used as cloud", () => {
      expect(resolveCloudKey(manifest, "claude")).toBeNull();
    });

    it("should return null for agent display name used as cloud", () => {
      expect(resolveCloudKey(manifest, "Claude Code")).toBeNull();
    });

    it("should return null for partial key match", () => {
      expect(resolveCloudKey(manifest, "hetz")).toBeNull();
    });

    it("should return null for misspelled cloud name", () => {
      expect(resolveCloudKey(manifest, "Hetznerr Cloud")).toBeNull();
    });
  });

  // ── Priority: exact key > case-insensitive key > display name ───────────

  describe("resolution priority", () => {
    it("should prefer exact key over case-insensitive match", () => {
      const result = resolveCloudKey(manifest, "vultr");
      expect(result).toBe("vultr");
    });

    it("should prefer case-insensitive key over display name", () => {
      // "Sprite" matches case-insensitively as key "sprite" (stage 2)
      // It also matches display name "Sprite" (stage 3)
      // Stage 2 should win
      const result = resolveCloudKey(manifest, "Sprite");
      expect(result).toBe("sprite");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-kind isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe("cross-kind isolation", () => {
  const manifest = createTestManifest();

  it("should not resolve cloud key via resolveAgentKey", () => {
    expect(resolveAgentKey(manifest, "sprite")).toBeNull();
    expect(resolveAgentKey(manifest, "hetzner")).toBeNull();
    expect(resolveAgentKey(manifest, "vultr")).toBeNull();
    expect(resolveAgentKey(manifest, "digital-ocean")).toBeNull();
  });

  it("should not resolve agent key via resolveCloudKey", () => {
    expect(resolveCloudKey(manifest, "claude")).toBeNull();
    expect(resolveCloudKey(manifest, "aider")).toBeNull();
    expect(resolveCloudKey(manifest, "goose")).toBeNull();
    expect(resolveCloudKey(manifest, "open-interpreter")).toBeNull();
  });

  it("should not resolve cloud display name via resolveAgentKey", () => {
    expect(resolveAgentKey(manifest, "Hetzner Cloud")).toBeNull();
    expect(resolveAgentKey(manifest, "DigitalOcean")).toBeNull();
    expect(resolveAgentKey(manifest, "Sprite")).toBeNull();
  });

  it("should not resolve agent display name via resolveCloudKey", () => {
    expect(resolveCloudKey(manifest, "Claude Code")).toBeNull();
    expect(resolveCloudKey(manifest, "Aider")).toBeNull();
    expect(resolveCloudKey(manifest, "Open Interpreter")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("should handle empty manifest", () => {
    const empty: Manifest = { agents: {}, clouds: {}, matrix: {} };
    expect(resolveAgentKey(empty, "claude")).toBeNull();
    expect(resolveCloudKey(empty, "sprite")).toBeNull();
  });

  it("should handle manifest with single agent", () => {
    const single: Manifest = {
      agents: {
        solo: {
          name: "Solo Agent",
          description: "Only agent",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {},
      matrix: {},
    };
    expect(resolveAgentKey(single, "solo")).toBe("solo");
    expect(resolveAgentKey(single, "SOLO")).toBe("solo");
    expect(resolveAgentKey(single, "Solo Agent")).toBe("solo");
    expect(resolveAgentKey(single, "other")).toBeNull();
  });

  it("should handle manifest with single cloud", () => {
    const single: Manifest = {
      agents: {},
      clouds: {
        "my-cloud": {
          name: "My Cloud Provider",
          description: "Only cloud",
          url: "",
          type: "cloud",
          auth: "TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: {},
    };
    expect(resolveCloudKey(single, "my-cloud")).toBe("my-cloud");
    expect(resolveCloudKey(single, "MY-CLOUD")).toBe("my-cloud");
    expect(resolveCloudKey(single, "My Cloud Provider")).toBe("my-cloud");
    expect(resolveCloudKey(single, "other")).toBeNull();
  });

  it("should handle input with leading/trailing spaces (no trim in function)", () => {
    const manifest = createTestManifest();
    // The function does NOT trim input, so spaces should cause no match
    expect(resolveAgentKey(manifest, " claude ")).toBeNull();
    expect(resolveCloudKey(manifest, " sprite ")).toBeNull();
  });

  it("should handle agent whose key and display name differ only in case", () => {
    const manifest: Manifest = {
      agents: {
        test: {
          name: "Test",
          description: "Test agent",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {},
      matrix: {},
    };
    // "Test" should resolve via case-insensitive key match (stage 2)
    expect(resolveAgentKey(manifest, "Test")).toBe("test");
    // "test" should resolve via exact key match (stage 1)
    expect(resolveAgentKey(manifest, "test")).toBe("test");
    // "TEST" should resolve via case-insensitive key match (stage 2)
    expect(resolveAgentKey(manifest, "TEST")).toBe("test");
  });

  it("should handle cloud whose display name contains the key", () => {
    const manifest = createTestManifest();
    // "hetzner" is the key, "Hetzner Cloud" is the display name
    // Searching for "hetzner" should match exactly (stage 1)
    expect(resolveCloudKey(manifest, "hetzner")).toBe("hetzner");
    // Searching for "Hetzner Cloud" should match display name (stage 3)
    expect(resolveCloudKey(manifest, "Hetzner Cloud")).toBe("hetzner");
    // Searching for just "Hetzner" should match case-insensitive key (stage 2)
    expect(resolveCloudKey(manifest, "Hetzner")).toBe("hetzner");
  });

  it("should handle agent whose display name is same as another agent's key", () => {
    // Create a scenario where display name of one agent equals key of another
    const tricky: Manifest = {
      agents: {
        alpha: {
          name: "beta",  // display name "beta" matches key of another agent
          description: "Agent alpha",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
        beta: {
          name: "Beta Agent",
          description: "Agent beta",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {},
      matrix: {},
    };
    // "beta" should resolve to exact key "beta" (stage 1), not to "alpha" via display name
    expect(resolveAgentKey(tricky, "beta")).toBe("beta");
    // "alpha" should resolve to exact key "alpha" (stage 1)
    expect(resolveAgentKey(tricky, "alpha")).toBe("alpha");
    // "Beta Agent" should resolve to "beta" via display name (stage 3)
    expect(resolveAgentKey(tricky, "Beta Agent")).toBe("beta");
  });

  it("should return first matching display name when multiple agents have similar names", () => {
    const manifest = createTestManifest();
    // Verify that each display name resolves to the correct key
    expect(resolveAgentKey(manifest, "Claude Code")).toBe("claude");
    expect(resolveAgentKey(manifest, "Aider")).toBe("aider");
    expect(resolveAgentKey(manifest, "Open Interpreter")).toBe("open-interpreter");
    expect(resolveAgentKey(manifest, "Goose")).toBe("goose");
  });
});
