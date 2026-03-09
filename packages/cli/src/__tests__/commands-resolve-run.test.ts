import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { loadManifest } from "../manifest";
import { isString } from "../shared/type-guards";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

/**
 * Tests for cmdRun display-name resolution and validateImplementation
 * suggestion paths in commands/run.ts.
 *
 * - cmdRun resolving case-insensitive display names and logging "Resolved" messages
 * - cmdRun resolving case-insensitive keys (e.g. "Claude" -> "claude")
 * - validateImplementation showing "see all N options" hint when > 3 clouds available
 * - validateImplementation showing "no implemented cloud providers" message
 * - cmdRun proceeding correctly after resolution (step log with agent/cloud names)
 */

const mockManifest = createMockManifest();

// Manifest with many clouds for the "> 3 clouds" suggestion test
const manyCloudManifest = {
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
      price: "test",
      url: "https://sprite.sh",
      type: "vm",
      auth: "token",
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
      auth: "token",
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
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    linode: {
      name: "Linode",
      description: "Cloud hosting",
      price: "test",
      url: "https://linode.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    digitalocean: {
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
    "sprite/claude": "implemented",
    "hetzner/claude": "implemented",
    "vultr/claude": "implemented",
    "linode/claude": "implemented",
    "digitalocean/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/codex": "missing",
    "vultr/codex": "missing",
    "linode/codex": "missing",
    "digitalocean/codex": "missing",
  },
};

// Manifest where an agent has zero implemented clouds
const noCloudManifest = {
  agents: {
    claude: mockManifest.agents.claude,
    codex: mockManifest.agents.codex,
  },
  clouds: {
    sprite: mockManifest.clouds.sprite,
    hetzner: mockManifest.clouds.hetzner,
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "missing",
    "hetzner/claude": "implemented",
    "hetzner/codex": "missing",
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
const { cmdRun } = await import("../commands/index.js");

describe("cmdRun - display name resolution", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  // Helper: set up fetch to return a specific manifest and serve script downloads
  function setManifestAndScript(manifest: any) {
    global.fetch = mock(async (url: string) => {
      if (isString(url) && url.includes("manifest.json")) {
        return new Response(JSON.stringify(manifest));
      }
      // Script download returns a valid script that will fail at execution
      // but pass validateScriptContent
      return new Response("#!/bin/bash\necho test");
    });
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
    await setManifestAndScript(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Display name resolution logging ────────────────────────────────

  describe("display name to key resolution", () => {
    it("should resolve agent display name and log resolution message", async () => {
      // "Claude Code" -> "claude" via display name match
      // But "Claude Code" has a space, so validateIdentifier will reject it
      // before resolution takes effect. The resolution happens BEFORE validation.
      // Actually, looking at the code: resolution happens first (line 255),
      // then validateIdentifier (line 268). But "Claude Code" contains a space
      // which will fail identifier validation after resolution since the resolved
      // key is "claude" (lowercase, valid).
      //
      // Wait: the code resolves agent first (line 255), then if resolved, replaces
      // agent with the resolved key. Then validateIdentifier runs on the NEW key.
      // So "Claude Code" resolves to "claude", then validateIdentifier("claude") passes.

      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("Claude Code", "sprite");
      } catch {
        // May throw from script execution or process.exit
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("claude"))).toBe(true);
    });

    it("should resolve cloud display name and log resolution message", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "Hetzner Cloud");
      } catch {
        // May throw from script execution or process.exit
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("hetzner"))).toBe(true);
    });

    it("should resolve both agent and cloud display names simultaneously", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("Claude Code", "Hetzner Cloud");
      } catch {
        // May throw from script execution or process.exit
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      const resolvedAgent = infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("claude"));
      const resolvedCloud = infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("hetzner"));
      expect(resolvedAgent).toBe(true);
      expect(resolvedCloud).toBe(true);
    });

    it("should not log resolution when exact keys are used", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved"))).toBe(false);
    });

    it("should resolve case-insensitive display name", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude code", "sprite");
      } catch {
        // May throw
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("claude"))).toBe(true);
    });
  });

  // ── Step log after successful resolution ────────────────────────────

  describe("launch message after resolution", () => {
    it("should show correct display names in launch message after resolution", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("Claude Code", "Hetzner Cloud");
      } catch {
        // May throw from script execution
      }

      const stepCalls = mockLogStep.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("Claude Code") && msg.includes("Hetzner Cloud"))).toBe(true);
    });

    it("should show 'with prompt' in launch message when prompt is provided", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite", "Fix all bugs");
      } catch {
        // May throw from script execution
      }

      const stepCalls = mockLogStep.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(true);
    });

    it("should not show 'with prompt' when no prompt given", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // May throw from script execution
      }

      const stepCalls = mockLogStep.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(false);
    });
  });

  // ── validateImplementation: > 3 clouds available suggestion ─────────

  describe("validateImplementation - many clouds suggestion", () => {
    it("should show 'see all N options' and at most 3 example commands when > 3 clouds available", async () => {
      // Create a manifest where claude has 4 implemented clouds but digitalocean is missing
      const partialManifest = {
        ...manyCloudManifest,
        matrix: {
          ...manyCloudManifest.matrix,
          "digitalocean/claude": "missing",
        },
      };
      await setManifestAndScript(partialManifest);

      try {
        await cmdRun("claude", "digitalocean");
      } catch {
        // Expected: process.exit from validateImplementation
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      // Should show the "see all N options" message since claude has 4 implemented clouds
      expect(infoCalls.some((msg: string) => msg.includes("4") && msg.includes("cloud"))).toBe(true);
      // Should suggest up to 3 example commands
      const exampleCmds = infoCalls.filter(
        (msg: string) => msg.includes("spawn claude") && !msg.includes("see all") && !msg.includes("to see"),
      );
      expect(exampleCmds.length).toBeGreaterThanOrEqual(1);
      expect(exampleCmds.length).toBeLessThanOrEqual(3);
    });

    it("should not show 'see all' when <= 3 clouds available", async () => {
      // mockManifest has claude on sprite + hetzner = 2 clouds
      // We need a missing combo: hetzner/codex is missing
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("codex", "hetzner");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      // codex has 1 implemented cloud (sprite), so no "see all" hint
      expect(infoCalls.some((msg: string) => msg.includes("to see all"))).toBe(false);
    });
  });

  // ── validateImplementation: no implemented clouds ──────────────────

  describe("validateImplementation - no implemented clouds", () => {
    it("should show 'no implemented cloud providers' and suggest 'spawn matrix'", async () => {
      await setManifestAndScript(noCloudManifest);

      try {
        await cmdRun("codex", "sprite");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("no implemented cloud providers"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("spawn matrix"))).toBe(true);
    });
  });

  // ── Display name resolution does not fire for unresolvable input ────

  describe("unresolvable display names", () => {
    it("should not log resolution for completely unknown agent display name", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("Unknown Agent Name", "sprite");
      } catch {
        // Expected: will fail at validateIdentifier (spaces)
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved"))).toBe(false);
    });

    it("should not log resolution for completely unknown cloud display name", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "Unknown Cloud");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: unknown[]) => c.join(" "));
      // No cloud resolution message should appear
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && !msg.includes("claude"))).toBe(false);
    });
  });
});
