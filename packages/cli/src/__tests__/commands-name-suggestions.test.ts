import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { loadManifest } from "../manifest";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

/**
 * Tests for the display-name suggestion branches in validateEntity
 * (commands/shared.ts) for both "agent" and "cloud" kinds.
 *
 * When a user types an unknown agent or cloud, validateEntity:
 *   1. Try findClosestMatch on keys (e.g. "claud" -> "claude")
 *   2. If that fails, try findClosestMatch on display names (e.g. "Codx" -> "Codex")
 *      and then look up the corresponding key
 *
 * The key-based suggestion path (step 1) is well tested in commands-error-paths.test.ts.
 * The display-name suggestion path (step 2) was NOT previously tested.
 *
 * This file covers:
 * - validateEntity (agent): display name suggestion when key suggestion fails
 * - validateEntity (cloud): display name suggestion when key suggestion fails
 * - Both key AND display name suggestions returning null (very different input)
 * Note: raw findClosestMatch unit tests live in fuzzy-key-matching.test.ts
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
      price: "test",
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
      price: "test",
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
      price: "test",
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

const {
  logError: mockLogError,
  logInfo: mockLogInfo,
  logStep: mockLogStep,
  logWarn: mockLogWarn,
  spinnerStart: mockSpinnerStart,
  spinnerStop: mockSpinnerStop,
} = mockClackPrompts();

// Import commands after mock setup
const { cmdRun, cmdAgentInfo, cmdCloudInfo } = await import("../commands/index.js");

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

  // ── validateEntity (agent): display name suggestion path ────────────

  describe("validateEntity (agent) - display name suggestion", () => {
    it("should suggest key via display name and show Unknown agent error", async () => {
      // User types "claude-code" -> key check fails (no key "claude-code"),
      // findClosestMatch on display names: "claude-code" vs "claude code" -> distance 1 -> match!
      // Then it looks up the key for "Claude Code" -> "cc"
      await expect(cmdRun("claude-code", "sp")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      // Should suggest "cc" (the key for "Claude Code") with the display name
      expect(infoCalls.some((msg: string) => msg.includes("cc") && msg.includes("Claude Code"))).toBe(true);

      const errorCalls = mockLogError.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown agent"))).toBe(true);
    });

    it("should suggest key via display name for close display name typo", async () => {
      // "codex-pro" vs display "Codex Pro": "codex-pro" vs "codex pro" -> distance 1 -> match!
      await expect(cmdRun("codex-pro", "sp")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("ap") && msg.includes("Codex Pro"))).toBe(true);
    });

    it("should not show display name suggestion when both key and name fail", async () => {
      // "xyzzyplugh" is far from all keys and all display names
      await expect(cmdRun("xyzzyplugh", "sp")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
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

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      // Should suggest via key match and always show display name for clarity
      expect(infoCalls.some((msg: string) => msg.includes("claude"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("Claude Code"))).toBe(true);
    });
  });

  // ── validateEntity (cloud): display name suggestion path ────────────

  describe("validateEntity (cloud) - display name suggestion", () => {
    it("should suggest key via display name and show Unknown cloud error", async () => {
      // "hetzner-cloud" -> display name "Hetzner Cloud":
      //   "hetzner-cloud" vs "hetzner cloud" -> distance 1 -> match!
      // But key "hz" is far (distance > 3) from "hetzner-cloud"
      await expect(cmdRun("cc", "hetzner-cloud")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("hz") && msg.includes("Hetzner Cloud"))).toBe(true);

      const errorCalls = mockLogError.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown cloud"))).toBe(true);
    });

    it("should suggest key via display name for digitalocean typo", async () => {
      // "digitalocen" (11 chars) vs display "DigitalOcean" (12 chars):
      //   "digitalocen" vs "digitalocean" -> distance 1 -> match!
      // Key "dc" (2 chars) is far from "digitalocen" -> key suggestion fails
      await expect(cmdRun("cc", "digitalocen")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("dc") && msg.includes("DigitalOcean"))).toBe(true);
    });

    it("should not show display name suggestion when both key and name fail", async () => {
      await expect(cmdRun("cc", "xyzzyplugh")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
    });

    it("should prefer key-based suggestion over display name suggestion", async () => {
      const standardManifest = createMockManifest();
      await setManifest(standardManifest);

      // "sprit" is close to key "sprite" (distance 1)
      await expect(cmdRun("claude", "sprit")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("sprite"))).toBe(true);
      // Should always show display name for clarity
      expect(infoCalls.some((msg: string) => msg.includes("Sprite"))).toBe(true);
    });
  });

  // ── cmdAgentInfo: display name suggestion via validateEntity ─────────

  describe("cmdAgentInfo - display name suggestion", () => {
    it("should show display name suggestion for unknown agent via cmdAgentInfo", async () => {
      // "claude-code" -> display "Claude Code" -> key "cc"
      await expect(cmdAgentInfo("claude-code")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("cc") && msg.includes("Claude Code"))).toBe(true);
    });

    it("should show spawn agents hint for completely unknown agent", async () => {
      await expect(cmdAgentInfo("totallyunknown")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn agents"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
    });
  });

  // ── cmdCloudInfo: display name suggestion via validateEntity ─────────

  describe("cmdCloudInfo - display name suggestion", () => {
    it("should show display name suggestion for unknown cloud via cmdCloudInfo", async () => {
      // "sprite-cloud" -> display "Sprite Cloud" -> key "sp"
      //   "sprite-cloud" vs "sprite cloud" -> distance 1 -> match!
      await expect(cmdCloudInfo("sprite-cloud")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("sp") && msg.includes("Sprite Cloud"))).toBe(true);
    });

    it("should show spawn clouds hint for completely unknown cloud", async () => {
      await expect(cmdCloudInfo("totallyunknown")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
    });
  });

  // ── Combined: agent + cloud both triggering display name suggestions ─

  describe("both agent and cloud display name suggestions", () => {
    it("should show agent suggestion even when cloud is also wrong", async () => {
      // Both "claude-code" and "hetzner-cloud" need display name resolution
      // cmdRun processes agent first, so agent error fires first
      await expect(cmdRun("claude-code", "hetzner-cloud")).rejects.toThrow("process.exit");

      const errorCalls = mockLogError.mock.calls.map((c: unknown[]) => c.join(" "));
      // Should fail on the agent first (agent validation runs before cloud validation)
      expect(errorCalls.some((msg: string) => msg.includes("Unknown agent"))).toBe(true);
    });
  });
});
