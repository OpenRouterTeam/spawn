import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for cmdRun display-name resolution and validateImplementation
 * suggestion paths in commands.ts.
 *
 * Existing tests cover:
 * - resolveAgentKey/resolveCloudKey as isolated functions (commands-helpers.test.ts)
 * - cmdRun error paths: invalid identifiers, unknown agents/clouds (commands-error-paths.test.ts)
 * - cmdRun swapped argument detection (commands-error-paths.test.ts)
 *
 * This file covers the UNTESTED integration paths:
 * - cmdRun resolving case-insensitive display names and logging "Resolved" messages
 * - cmdRun resolving case-insensitive keys (e.g. "Claude" -> "claude")
 * - validateImplementation showing "see all N options" hint when > 3 clouds available
 * - validateImplementation showing "no implemented cloud providers" message
 * - cmdRun proceeding correctly after resolution (step log with agent/cloud names)
 *
 * Agent: test-engineer
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
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
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
    "sprite/aider": "implemented",
    "hetzner/aider": "missing",
    "vultr/aider": "missing",
    "linode/aider": "missing",
    "digitalocean/aider": "missing",
  },
};

// Manifest where an agent has zero implemented clouds
const noCloudManifest = {
  agents: {
    claude: mockManifest.agents.claude,
    aider: mockManifest.agents.aider,
  },
  clouds: {
    sprite: mockManifest.clouds.sprite,
    hetzner: mockManifest.clouds.hetzner,
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "missing",
    "hetzner/claude": "implemented",
    "hetzner/aider": "missing",
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
  isCancel: () => false,
}));

// Import commands after mock setup
const { cmdRun } = await import("../commands.js");

describe("cmdRun - display name resolution", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  // Helper: set up fetch to return a specific manifest and serve script downloads
  function setManifestAndScript(manifest: any) {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => manifest,
          text: async () => JSON.stringify(manifest),
        };
      }
      // Script download returns a valid script that will fail at execution
      // but pass validateScriptContent
      return {
        ok: true,
        text: async () => "#!/bin/bash\necho test",
      };
    }) as any;
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

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

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

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("claude"))).toBe(true);
    });

    it("should resolve cloud display name and log resolution message", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "Hetzner Cloud");
      } catch {
        // May throw from script execution or process.exit
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("hetzner"))).toBe(true);
    });

    it("should resolve both agent and cloud display names simultaneously", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("Claude Code", "Hetzner Cloud");
      } catch {
        // May throw from script execution or process.exit
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
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

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved"))).toBe(false);
    });

    it("should resolve case-insensitive display name", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude code", "sprite");
      } catch {
        // May throw
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
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

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("Claude Code") && msg.includes("Hetzner Cloud"))).toBe(true);
    });

    it("should show 'with prompt' in launch message when prompt is provided", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite", "Fix all bugs");
      } catch {
        // May throw from script execution
      }

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(true);
    });

    it("should not show 'with prompt' when no prompt given", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // May throw from script execution
      }

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(false);
    });
  });

  // ── validateImplementation: > 3 clouds available suggestion ─────────

  describe("validateImplementation - many clouds suggestion", () => {
    it("should show 'see all N options' when > 3 clouds available and combination missing", async () => {
      await setManifestAndScript(manyCloudManifest);

      // claude has 5 implemented clouds; request a cloud that doesn't exist
      // Actually we need a cloud that exists but where the combination is "missing"
      // In manyCloudManifest, aider is only on sprite; hetzner/aider is missing
      // But aider only has 1 implemented cloud so it won't trigger "> 3"
      // claude has 5 clouds, but all are implemented so it won't trigger
      // Let's use the manifest differently: request a non-implemented combo
      // We need an agent with > 3 implemented clouds but where a specific cloud is missing

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

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // Should show the "see all N options" message since claude has 4 implemented clouds
      expect(infoCalls.some((msg: string) => msg.includes("4") && msg.includes("cloud"))).toBe(true);
      // Should also suggest up to 3 example commands
      const exampleCmds = infoCalls.filter((msg: string) => msg.includes("spawn claude"));
      expect(exampleCmds.length).toBeGreaterThanOrEqual(1);
    });

    it("should show at most 3 example commands when many clouds available", async () => {
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
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // Count example spawn commands (not the "see all" hint)
      const exampleCmds = infoCalls.filter((msg: string) =>
        msg.includes("spawn claude") && !msg.includes("see all") && !msg.includes("to see")
      );
      expect(exampleCmds.length).toBeLessThanOrEqual(3);
    });

    it("should not show 'see all' when <= 3 clouds available", async () => {
      // mockManifest has claude on sprite + hetzner = 2 clouds
      // We need a missing combo: hetzner/aider is missing
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("aider", "hetzner");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // aider has 1 implemented cloud (sprite), so no "see all" hint
      expect(infoCalls.some((msg: string) => msg.includes("to see all"))).toBe(false);
    });
  });

  // ── validateImplementation: no implemented clouds ──────────────────

  describe("validateImplementation - no implemented clouds", () => {
    it("should show 'no implemented cloud providers' for agent with zero clouds", async () => {
      await setManifestAndScript(noCloudManifest);

      try {
        await cmdRun("aider", "sprite");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("no implemented cloud providers"))).toBe(true);
    });

    it("should suggest 'spawn list' when no clouds available", async () => {
      await setManifestAndScript(noCloudManifest);

      try {
        await cmdRun("aider", "sprite");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn list"))).toBe(true);
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

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved"))).toBe(false);
    });

    it("should not log resolution for completely unknown cloud display name", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "Unknown Cloud");
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      // No cloud resolution message should appear
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && !msg.includes("claude"))).toBe(false);
    });
  });
});
