import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for the display-name suggestion branches in validateAgent and
 * validateCloud (commands.ts lines 145-199).
 *
 * When a user types an unknown agent or cloud, validateAgent/validateCloud:
 *   1. Try findClosestMatch on keys (e.g. "claud" -> "claude")
 *   2. If that fails, try findClosestMatch on display names (e.g. "Codx" -> "Codex")
 *      and then look up the corresponding key
 *
 * The key-based suggestion path (step 1) is well tested in commands-error-paths.test.ts.
 * The display-name suggestion path (step 2) was NOT previously tested.
 *
 * This file covers:
 * - validateAgent: display name suggestion when key suggestion fails
 * - validateCloud: display name suggestion when key suggestion fails
 * - Both key AND display name suggestions returning null (very different input)
 * - findClosestMatch with display names via the full cmdRun / cmdAgentInfo paths
 */

// Manifest with names very different from keys so key-based suggestion fails
// but display-name-based suggestion can succeed
const manifestWithDistinctNames = {
  agents: {
    cc: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: {
        ANTHROPIC_API_KEY: "test",
      },
    },
    ap: {
      name: "Codex Pro",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
      env: {
        OPENAI_API_KEY: "test",
      },
    },
    oi: {
      name: "GPTMe",
      description: "AI terminal assistant",
      url: "https://gptme.dev",
      install: "pip install gptme",
      launch: "gptme",
      env: {
        OPENAI_API_KEY: "test",
      },
    },
  },
  clouds: {
    sp: {
      name: "Sprite Cloud",
      description: "Lightweight VMs",
      url: "https://sprite.sh",
      type: "vm",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    hz: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    dc: {
      name: "DigitalOcean",
      description: "Cloud infrastructure",
      url: "https://digitalocean.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sp/cc": "implemented",
    "sp/ap": "implemented",
    "sp/oi": "implemented",
    "hz/cc": "implemented",
    "hz/ap": "missing",
    "hz/oi": "missing",
    "dc/cc": "implemented",
    "dc/ap": "missing",
    "dc/oi": "missing",
  },
};

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mock(() => {}),
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    error: mockLogError,
    warn: mockLogWarn,
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

// Import commands after mock setup
const { cmdRun, cmdAgentInfo, cmdCloudInfo, findClosestMatch } = await import("../commands.js");

describe("Display Name Suggestions in Validation Errors", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => new Response(JSON.stringify(manifest)));
    return loadManifest(true);
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;
    await setManifest(manifestWithDistinctNames);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── validateAgent: display name suggestion path ─────────────────────

  describe("validateAgent - display name suggestion", () => {
    it("should suggest key via display name when key-based suggestion fails", async () => {
      // "codex" is far from keys ["cc", "ap", "oi"] (all distance > 3)
      // But "Codex Pro" display name is close to "codex" via findClosestMatch
      // on display names: findClosestMatch("codex", ["Claude Code", "Codex Pro", "GPTMe"])
      // "codex" vs "Codex Pro" -> lowercase: "codex" vs "codex pro" -> distance 4 (too far)
      // Let's use a closer typo: "codex-pro" would match "ap" display name "Codex Pro"
      // Actually, findClosestMatch is case-insensitive and max distance 3.
      // So we need a name within distance 3 of a display name.
      // "codex-pr" is 6 chars, "Codex Pro" is 9 chars. Distance too high.
      // Let's try: user types "claude-cod" (10 chars), display name "Claude Code" (11 chars) -> distance 2.
      // But validateIdentifier rejects hyphens... wait no, hyphens are valid in identifiers.
      // User types "claude-code" -> key check fails (no key "claude-code"),
      // findClosestMatch("claude-code", ["cc", "ap", "oi"]) -> all distance > 3 -> null.
      // findClosestMatch("claude-code", ["Claude Code", "Codex Pro", "GPTMe"]):
      //   "claude-code" vs "claude code" -> distance 1 (hyphen vs space)
      //   That's within threshold 3 -> returns "Claude Code"
      // Then it looks up the key for "Claude Code" -> "cc"
      // This tests the nameSuggestion branch!
      await expect(cmdRun("claude-code", "sp")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // Should suggest "cc" (the key for "Claude Code") with the display name
      expect(infoCalls.some((msg: string) => msg.includes("cc") && msg.includes("Claude Code"))).toBe(true);
    });

    it("should suggest key via display name for close display name typo", async () => {
      // "gptme-x" (7 chars) vs display name "GPTMe" (5 chars) -> distance 2 (close enough)
      // Let's try "codex-pro" -> display "Codex Pro":
      //   "codex-pro" vs "codex pro" -> distance 1 -> match!
      await expect(cmdRun("codex-pro", "sp")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("ap") && msg.includes("Codex Pro"))).toBe(true);
    });

    it("should show 'Unknown agent' error even with display name suggestion", async () => {
      await expect(cmdRun("claude-code", "sp")).rejects.toThrow("process.exit");

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown agent"))).toBe(true);
    });

    it("should not show display name suggestion when both key and name fail", async () => {
      // "xyzzyplugh" is far from all keys and all display names
      await expect(cmdRun("xyzzyplugh", "sp")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // No "Did you mean" suggestion
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
      // But should still suggest "spawn agents"
      expect(infoCalls.some((msg: string) => msg.includes("spawn agents"))).toBe(true);
    });

    it("should prefer key-based suggestion over display name suggestion", async () => {
      // Use the standard manifest where key "claude" is close to typos
      const standardManifest = createMockManifest();
      await setManifest(standardManifest);

      // "claud" is close to key "claude" (distance 1)
      await expect(cmdRun("claud", "sprite")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // Should suggest via key match and always show display name for clarity
      expect(infoCalls.some((msg: string) => msg.includes("claude"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("Claude Code"))).toBe(true);
    });
  });

  // ── validateCloud: display name suggestion path ─────────────────────

  describe("validateCloud - display name suggestion", () => {
    it("should suggest key via display name when key-based suggestion fails", async () => {
      // "hetzner-cloud" -> display name "Hetzner Cloud":
      //   "hetzner-cloud" vs "hetzner cloud" -> distance 1 -> match!
      // But key "hz" is far (distance > 3) from "hetzner-cloud"
      await expect(cmdRun("cc", "hetzner-cloud")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("hz") && msg.includes("Hetzner Cloud"))).toBe(true);
    });

    it("should suggest key via display name for digitalocean typo", async () => {
      // "digitalocen" (11 chars) vs display "DigitalOcean" (12 chars):
      //   "digitalocen" vs "digitalocean" -> distance 1 -> match!
      // Key "dc" (2 chars) is far from "digitalocen" -> key suggestion fails
      await expect(cmdRun("cc", "digitalocen")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("dc") && msg.includes("DigitalOcean"))).toBe(true);
    });

    it("should show 'Unknown cloud' error even with display name suggestion", async () => {
      await expect(cmdRun("cc", "hetzner-cloud")).rejects.toThrow("process.exit");

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown cloud"))).toBe(true);
    });

    it("should not show display name suggestion when both key and name fail", async () => {
      await expect(cmdRun("cc", "xyzzyplugh")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
    });

    it("should prefer key-based suggestion over display name suggestion", async () => {
      const standardManifest = createMockManifest();
      await setManifest(standardManifest);

      // "sprit" is close to key "sprite" (distance 1)
      await expect(cmdRun("claude", "sprit")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("sprite"))).toBe(true);
      // Should always show display name for clarity
      expect(infoCalls.some((msg: string) => msg.includes("Sprite"))).toBe(true);
    });
  });

  // ── cmdAgentInfo: display name suggestion via validateAgent ──────────

  describe("cmdAgentInfo - display name suggestion", () => {
    it("should show display name suggestion for unknown agent via cmdAgentInfo", async () => {
      // "claude-code" -> display "Claude Code" -> key "cc"
      await expect(cmdAgentInfo("claude-code")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("cc") && msg.includes("Claude Code"))).toBe(true);
    });

    it("should show spawn agents hint for completely unknown agent", async () => {
      await expect(cmdAgentInfo("totallyunknown")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn agents"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
    });
  });

  // ── cmdCloudInfo: display name suggestion via validateCloud ──────────

  describe("cmdCloudInfo - display name suggestion", () => {
    it("should show display name suggestion for unknown cloud via cmdCloudInfo", async () => {
      // "sprite-cloud" -> display "Sprite Cloud" -> key "sp"
      //   "sprite-cloud" vs "sprite cloud" -> distance 1 -> match!
      await expect(cmdCloudInfo("sprite-cloud")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("sp") && msg.includes("Sprite Cloud"))).toBe(true);
    });

    it("should show spawn clouds hint for completely unknown cloud", async () => {
      await expect(cmdCloudInfo("totallyunknown")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
    });
  });

  // ── findClosestMatch with display names ─────────────────────────────

  describe("findClosestMatch with display name arrays", () => {
    const displayNames = [
      "Claude Code",
      "Codex Pro",
      "GPTMe",
    ];

    it("should match close display name (distance 1)", () => {
      // "claude-code" vs "Claude Code" -> case-insensitive: "claude-code" vs "claude code" -> dist 1
      expect(findClosestMatch("claude-code", displayNames)).toBe("Claude Code");
    });

    it("should match close display name with simple typo", () => {
      // "codex pro" vs "Codex Pro" -> case-insensitive: exact match -> dist 0
      expect(findClosestMatch("codex pro", displayNames)).toBe("Codex Pro");
    });

    it("should match close display name with minor typo", () => {
      // "codex-pro" vs "Codex Pro" -> "codex-pro" vs "codex pro" -> dist 1
      expect(findClosestMatch("codex-pro", displayNames)).toBe("Codex Pro");
    });

    it("should return null for display names too different", () => {
      // "kubernetes" is far from all display names
      expect(findClosestMatch("kubernetes", displayNames)).toBeNull();
    });

    it("should handle single-word display names", () => {
      const names = [
        "Sprite",
        "Hetzner",
        "Vultr",
      ];
      expect(findClosestMatch("sprit", names)).toBe("Sprite");
      expect(findClosestMatch("hetzne", names)).toBe("Hetzner");
    });

    it("should handle case-insensitive comparison with display names", () => {
      expect(findClosestMatch("CLAUDE CODE", displayNames)).toBe("Claude Code");
      expect(findClosestMatch("CODEX PRO", displayNames)).toBe("Codex Pro");
    });

    it("should pick closest among multiple close display names", () => {
      const names = [
        "Codex",
        "Codex Pro",
        "Clin",
      ];
      // "codx" -> "codex" (dist 1), "codex pro" (dist 5), "clin" (dist 3)
      // Codex is closest at dist 1
      expect(findClosestMatch("codx", names)).toBe("Codex");
    });
  });

  // ── Combined: agent + cloud both triggering display name suggestions ─

  describe("both agent and cloud display name suggestions", () => {
    it("should show agent suggestion even when cloud is also wrong", async () => {
      // Both "claude-code" and "hetzner-cloud" need display name resolution
      // cmdRun processes agent first, so agent error fires first
      await expect(cmdRun("claude-code", "hetzner-cloud")).rejects.toThrow("process.exit");

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      // Should fail on the agent first (validateAgent runs before validateCloud)
      expect(errorCalls.some((msg: string) => msg.includes("Unknown agent"))).toBe(true);
    });
  });
});
