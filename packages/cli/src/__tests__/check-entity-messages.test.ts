import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Tests for checkEntity output messages (commands.ts:177-216).
 *
 * The existing check-entity.test.ts verifies return values (true/false)
 * but does not capture the messages output via @clack/prompts log calls.
 * This file mocks @clack/prompts to verify the user-facing messages for:
 *
 * 1. Same-kind fuzzy match: "Did you mean X?" + listCmd hint (PR #510 added listCmd)
 * 2. Cross-kind fuzzy match: "looks like {kind} X" + swap warning (PR #510)
 * 3. Exact wrong-type detection: "X is a cloud, not an agent" (existing)
 * 4. No match at all: just the listCmd hint (existing)
 *
 * Agent: test-engineer
 */

// ── Mock @clack/prompts ─────────────────────────────────────────────────────

const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mockLogInfo,
    warn: mock(() => {}),
    error: mockLogError,
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

// Import after mocking
const { checkEntity } = await import("../commands.js");

// ── Test Fixtures ───────────────────────────────────────────────────────────

function createManifest(): Manifest {
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
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/codex": "implemented",
      "hetzner/claude": "implemented",
      "hetzner/codex": "missing",
    },
  };
}

function infoCalls(): string[] {
  return mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
}

function errorCalls(): string[] {
  return mockLogError.mock.calls.map((c: unknown[]) => c.join(" "));
}

// ── Tests ───────────────────────────────────────────────────────────────────

let manifest: Manifest;

describe("checkEntity message output", () => {
  beforeEach(() => {
    manifest = createManifest();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
  });

  // ── Exact wrong-type detection ──────────────────────────────────────────

  describe("exact wrong-type detection messages", () => {
    it("should say cloud name 'is a cloud provider, not an agent'", () => {
      checkEntity(manifest, "sprite", "agent");

      const errors = errorCalls();
      expect(errors.some((m) => m.includes("Unknown agent"))).toBe(true);

      const info = infoCalls();
      expect(info.some((m) => m.includes("is a cloud provider"))).toBe(true);
      expect(info.some((m) => m.includes("not an agent"))).toBe(true);
    });

    it("should say agent name 'is an agent, not a cloud provider'", () => {
      checkEntity(manifest, "claude", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("is an agent"))).toBe(true);
      expect(info.some((m) => m.includes("not a cloud provider"))).toBe(true);
    });

    it("should show usage hint for wrong-type detection", () => {
      checkEntity(manifest, "sprite", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn <agent> <cloud>"))).toBe(true);
    });

    it("should show list command hint for wrong-type agent check", () => {
      checkEntity(manifest, "sprite", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn agents"))).toBe(true);
    });

    it("should show list command hint for wrong-type cloud check", () => {
      checkEntity(manifest, "claude", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn clouds"))).toBe(true);
    });
  });

  // ── Same-kind fuzzy match messages ──────────────────────────────────────

  describe("same-kind fuzzy match messages", () => {
    it("should suggest 'Did you mean claude?' for 'claud' as agent", () => {
      checkEntity(manifest, "claud", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Did you mean") && m.includes("claude"))).toBe(true);
    });

    it("should show spawn command suggestion for same-kind match", () => {
      checkEntity(manifest, "claud", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn claude") || m.includes("spawn claud"))).toBe(true);
    });

    it("should show list command hint after same-kind match", () => {
      checkEntity(manifest, "claud", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn agents"))).toBe(true);
    });

    it("should suggest 'Did you mean sprite?' for 'sprit' as cloud", () => {
      checkEntity(manifest, "sprit", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Did you mean") && m.includes("sprite"))).toBe(true);
    });

    it("should show list command hint for cloud fuzzy match", () => {
      checkEntity(manifest, "sprit", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn clouds"))).toBe(true);
    });

    it("should include display name in suggestion", () => {
      checkEntity(manifest, "claud", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Claude Code"))).toBe(true);
    });
  });

  // ── Cross-kind fuzzy match messages (PR #510) ───────────────────────────

  describe("cross-kind fuzzy match messages", () => {
    it("should say 'looks like cloud X' for typo matching opposite kind", () => {
      // "htzner" as agent is close to cloud "hetzner"
      checkEntity(manifest, "htzner", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("looks like") && m.includes("hetzner"))).toBe(true);
    });

    it("should mention display name in cross-kind suggestion", () => {
      checkEntity(manifest, "htzner", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Hetzner Cloud"))).toBe(true);
    });

    it("should ask 'Did you swap the agent and cloud arguments?'", () => {
      checkEntity(manifest, "htzner", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("swap the agent and cloud"))).toBe(true);
    });

    it("should show usage hint for cross-kind match", () => {
      checkEntity(manifest, "htzner", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn <agent> <cloud>"))).toBe(true);
    });

    it("should say 'looks like agent X' for cloud typo matching agent", () => {
      // "claud" as cloud is close to agent "claude"
      checkEntity(manifest, "claud", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("looks like") && m.includes("claude"))).toBe(true);
    });

    it("should include agent display name for cloud cross-kind match", () => {
      checkEntity(manifest, "claud", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Claude Code"))).toBe(true);
    });

    it("should prefer same-kind match over cross-kind match for 'sprit' as cloud", () => {
      // "sprit" as cloud should match same-kind cloud "sprite" with "Did you mean"
      // rather than cross-kind
      checkEntity(manifest, "sprit", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Did you mean") && m.includes("sprite"))).toBe(true);
      expect(info.some((m) => m.includes("looks like"))).toBe(false);
    });

    it("should prefer same-kind match over cross-kind match for 'claud' as agent", () => {
      // "claud" as agent should match same-kind agent "claude" with "Did you mean"
      checkEntity(manifest, "claud", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("Did you mean") && m.includes("claude"))).toBe(true);
      expect(info.some((m) => m.includes("looks like"))).toBe(false);
    });
  });

  // ── No match at all messages ────────────────────────────────────────────

  describe("no match messages", () => {
    it("should show only list command hint when no match found for agent", () => {
      checkEntity(manifest, "kubernetes", "agent");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn agents"))).toBe(true);
      expect(info.some((m) => m.includes("Did you mean"))).toBe(false);
      expect(info.some((m) => m.includes("looks like"))).toBe(false);
    });

    it("should show only list command hint when no match found for cloud", () => {
      checkEntity(manifest, "amazonaws", "cloud");

      const info = infoCalls();
      expect(info.some((m) => m.includes("spawn clouds"))).toBe(true);
      expect(info.some((m) => m.includes("Did you mean"))).toBe(false);
      expect(info.some((m) => m.includes("looks like"))).toBe(false);
    });

    it("should show 'Unknown agent' error for non-matching agent", () => {
      checkEntity(manifest, "kubernetes", "agent");

      const errors = errorCalls();
      expect(errors.some((m) => m.includes("Unknown agent"))).toBe(true);
    });

    it("should show 'Unknown cloud' error for non-matching cloud", () => {
      checkEntity(manifest, "amazonaws", "cloud");

      const errors = errorCalls();
      expect(errors.some((m) => m.includes("Unknown cloud"))).toBe(true);
    });
  });

  // ── Valid entities produce no messages ──────────────────────────────────

  describe("valid entities produce no messages", () => {
    it("should not log any errors for valid agent", () => {
      checkEntity(manifest, "claude", "agent");
      expect(mockLogError.mock.calls.length).toBe(0);
      expect(mockLogInfo.mock.calls.length).toBe(0);
    });

    it("should not log any errors for valid cloud", () => {
      checkEntity(manifest, "sprite", "cloud");
      expect(mockLogError.mock.calls.length).toBe(0);
      expect(mockLogInfo.mock.calls.length).toBe(0);
    });
  });
});
