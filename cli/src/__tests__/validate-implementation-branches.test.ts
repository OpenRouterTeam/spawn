import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for validateImplementation branching in commands.ts (lines 233-256).
 *
 * When a user requests an unimplemented agent+cloud combination, validateImplementation
 * shows different messages depending on how many other clouds ARE available:
 *
 * 1. availableClouds.length > 0 && <= 3: show all available clouds as examples
 * 2. availableClouds.length > 3: show first 3, then "Run spawn X to see all N options"
 * 3. availableClouds.length === 0: show "no implemented cloud providers yet" + suggest "spawn list"
 *
 * Existing tests (commands-error-paths.test.ts) only cover case 1 with exactly 1 cloud.
 * This file tests the untested cases 2 and 3, plus edge cases.
 *
 * Agent: test-engineer
 */

// ── Test manifests ────────────────────────────────────────────────────────────

// Manifest with 5 clouds implemented for "claude" but "broken" cloud is NOT implemented
// This tests the >3 branch: "Run spawn claude to see all 5 options"
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
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
    linode: {
      name: "Linode",
      description: "Cloud hosting",
      url: "https://linode.com",
      type: "cloud",
      auth: "LINODE_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    digitalocean: {
      name: "DigitalOcean",
      description: "Cloud infrastructure",
      url: "https://digitalocean.com",
      type: "cloud",
      auth: "DO_API_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    broken: {
      name: "Broken Cloud",
      description: "Broken provider",
      url: "https://broken.dev",
      type: "cloud",
      auth: "BROKEN_TOKEN",
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
    "broken/claude": "missing",
    "sprite/codex": "missing",
    "hetzner/codex": "missing",
    "vultr/codex": "missing",
    "linode/codex": "missing",
    "digitalocean/codex": "missing",
    "broken/codex": "missing",
  },
};

// Manifest where codex has exactly 3 implemented clouds (boundary case)
const threeCloudManifest = {
  agents: {
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
    broken: {
      name: "Broken Cloud",
      description: "Broken provider",
      url: "https://broken.dev",
      type: "cloud",
      auth: "BROKEN_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/codex": "implemented",
    "hetzner/codex": "implemented",
    "vultr/codex": "implemented",
    "broken/codex": "missing",
  },
};

// Manifest where codex has exactly 4 clouds (first case >3)
const fourCloudManifest = {
  agents: {
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
    linode: {
      name: "Linode",
      description: "Cloud hosting",
      url: "https://linode.com",
      type: "cloud",
      auth: "LINODE_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    broken: {
      name: "Broken Cloud",
      description: "Broken provider",
      url: "https://broken.dev",
      type: "cloud",
      auth: "BROKEN_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/codex": "implemented",
    "hetzner/codex": "implemented",
    "vultr/codex": "implemented",
    "linode/codex": "implemented",
    "broken/codex": "missing",
  },
};

// Manifest where codex has 0 clouds implemented
const noCloudManifest = {
  agents: {
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/codex": "missing",
    "hetzner/codex": "missing",
  },
};

// Manifest where codex has exactly 2 clouds (existing tested case, included for completeness)
const twoCloudManifest = {
  agents: {
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    broken: {
      name: "Broken Cloud",
      description: "Broken provider",
      url: "https://broken.dev",
      type: "cloud",
      auth: "BROKEN_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/codex": "implemented",
    "hetzner/codex": "implemented",
    "broken/codex": "missing",
  },
};

// ── Mock @clack/prompts ───────────────────────────────────────────────────────

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
const { cmdRun } = await import("../commands.js");

describe("validateImplementation branching", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getInfoMessages(): string[] {
    return mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
  }

  function getErrorMessages(): string[] {
    return mockLogError.mock.calls.map((c: any[]) => c.join(" "));
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Branch: 0 available clouds ────────────────────────────────────────────

  describe("zero available clouds", () => {
    it("should show 'no implemented cloud providers' when agent has 0 clouds", async () => {
      await setManifest(noCloudManifest);

      await expect(cmdRun("codex", "sprite")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      expect(infos.some((msg: string) => msg.includes("no implemented cloud providers"))).toBe(true);
    });

    it("should suggest 'spawn matrix' when agent has 0 clouds", async () => {
      await setManifest(noCloudManifest);

      await expect(cmdRun("codex", "hetzner")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      expect(infos.some((msg: string) => msg.includes("spawn matrix"))).toBe(true);
    });

    it("should NOT show example spawn commands when agent has 0 clouds", async () => {
      await setManifest(noCloudManifest);

      await expect(cmdRun("codex", "sprite")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      // Should not have any "spawn codex <cloud>" examples
      expect(infos.some((msg: string) => /spawn codex \w+/.test(msg) && !msg.includes("spawn matrix"))).toBe(false);
    });

    it("should show 'not yet implemented' error message", async () => {
      await setManifest(noCloudManifest);

      await expect(cmdRun("codex", "sprite")).rejects.toThrow("process.exit");

      const errors = getErrorMessages();
      expect(errors.some((msg: string) => msg.includes("not yet implemented"))).toBe(true);
    });

    it("should include agent and cloud display names in error", async () => {
      await setManifest(noCloudManifest);

      await expect(cmdRun("codex", "sprite")).rejects.toThrow("process.exit");

      const errors = getErrorMessages();
      expect(errors.some((msg: string) => msg.includes("Codex") && msg.includes("Sprite"))).toBe(true);
    });
  });

  // ── Branch: 1-3 available clouds (show all as examples) ───────────────────

  describe("1-3 available clouds (show all examples)", () => {
    it("should show 2 example commands when agent has 2 clouds", async () => {
      await setManifest(twoCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      const exampleLines = infos.filter((msg: string) => msg.includes("spawn codex"));
      // Should show exactly 2 cloud alternatives
      expect(exampleLines.length).toBe(2);
      expect(infos.some((msg: string) => msg.includes("spawn codex sprite"))).toBe(true);
      expect(infos.some((msg: string) => msg.includes("spawn codex hetzner"))).toBe(true);
    });

    it("should show cloud count with correct singular/plural", async () => {
      await setManifest(twoCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      expect(infos.some((msg: string) => msg.includes("2 clouds"))).toBe(true);
    });

    it("should show 3 examples at boundary (exactly 3 clouds)", async () => {
      await setManifest(threeCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      const exampleLines = infos.filter((msg: string) => msg.includes("spawn codex"));
      expect(exampleLines.length).toBe(3);
      expect(infos.some((msg: string) => msg.includes("spawn codex sprite"))).toBe(true);
      expect(infos.some((msg: string) => msg.includes("spawn codex hetzner"))).toBe(true);
      expect(infos.some((msg: string) => msg.includes("spawn codex vultr"))).toBe(true);
    });

    it("should NOT show 'see all' hint when exactly 3 clouds", async () => {
      await setManifest(threeCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      // Should NOT have the "Run spawn X to see all" message
      expect(infos.some((msg: string) => msg.includes("to see all"))).toBe(false);
    });

    it("should use singular 'cloud' for exactly 1 cloud", async () => {
      // Modify manifest to have only 1 implemented cloud
      const oneCloudManifest = {
        agents: noCloudManifest.agents,
        clouds: noCloudManifest.clouds,
        matrix: {
          "sprite/codex": "implemented",
          "hetzner/codex": "missing",
        },
      };
      await setManifest(oneCloudManifest);

      await expect(cmdRun("codex", "hetzner")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      // Should say "1 cloud" (singular) not "1 clouds"
      expect(infos.some((msg: string) => msg.includes("1 cloud") && !msg.includes("1 clouds"))).toBe(true);
    });
  });

  // ── Branch: >3 available clouds (show first 3, then "see all") ────────────

  describe("more than 3 available clouds (truncated with see-all hint)", () => {
    it("should show only 3 example commands when agent has 4 clouds", async () => {
      await setManifest(fourCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      const exampleLines = infos.filter((msg: string) =>
        /spawn codex (sprite|hetzner|vultr|linode)/.test(msg)
      );
      expect(exampleLines.length).toBe(3);
    });

    it("should show 'see all' hint when agent has 4 clouds", async () => {
      await setManifest(fourCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      expect(infos.some((msg: string) => msg.includes("to see all") && msg.includes("4"))).toBe(true);
    });

    it("should include 'spawn codex' in the see-all hint", async () => {
      await setManifest(fourCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      const seeAllLine = infos.find((msg: string) => msg.includes("to see all"));
      expect(seeAllLine).toBeDefined();
      expect(seeAllLine!).toContain("spawn codex");
    });

    it("should show only 3 example commands when agent has 5 clouds", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      const exampleLines = infos.filter((msg: string) =>
        /spawn claude (sprite|hetzner|vultr|linode|digitalocean)/.test(msg)
      );
      expect(exampleLines.length).toBe(3);
    });

    it("should show 'see all 5 options' when agent has 5 clouds", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      expect(infos.some((msg: string) => msg.includes("to see all") && msg.includes("5"))).toBe(true);
    });

    it("should show cloud count with plural 'clouds' for 5", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      expect(infos.some((msg: string) => msg.includes("5 clouds"))).toBe(true);
    });

    it("should still show 'not yet implemented' error for >3 clouds", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const errors = getErrorMessages();
      expect(errors.some((msg: string) => msg.includes("not yet implemented"))).toBe(true);
    });

    it("should include agent and cloud names in error for >3 clouds", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const errors = getErrorMessages();
      expect(errors.some((msg: string) => msg.includes("Claude Code") && msg.includes("Broken Cloud"))).toBe(true);
    });

    it("should show 0 implemented clouds and no examples for codex on broken-cloud manifest", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      // codex has 0 implemented clouds in this manifest
      expect(infos.some((msg: string) => msg.includes("no implemented cloud providers"))).toBe(true);
      expect(infos.some((msg: string) => msg.includes("spawn matrix"))).toBe(true);
    });
  });

  // ── Error message content ─────────────────────────────────────────────────

  describe("error message formatting", () => {
    it("should show agent display name (not key) in error", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const errors = getErrorMessages();
      // Should use "Claude Code" not "claude"
      expect(errors.some((msg: string) => msg.includes("Claude Code"))).toBe(true);
    });

    it("should show cloud display name (not key) in error", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      const errors = getErrorMessages();
      // Should use "Broken Cloud" not "broken"
      expect(errors.some((msg: string) => msg.includes("Broken Cloud"))).toBe(true);
    });

    it("should call process.exit(1) for unimplemented combo", async () => {
      await setManifest(manyCloudManifest);

      await expect(cmdRun("claude", "broken")).rejects.toThrow("process.exit");

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Boundary: exactly at the 3-cloud threshold ────────────────────────────

  describe("threshold boundary (3 vs 4 clouds)", () => {
    it("should NOT truncate at exactly 3 clouds", async () => {
      await setManifest(threeCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      // All 3 should be shown as examples
      expect(infos.filter((msg: string) => msg.includes("spawn codex")).length).toBe(3);
      // No truncation hint
      expect(infos.some((msg: string) => msg.includes("to see all"))).toBe(false);
    });

    it("should truncate at exactly 4 clouds", async () => {
      await setManifest(fourCloudManifest);

      await expect(cmdRun("codex", "broken")).rejects.toThrow("process.exit");

      const infos = getInfoMessages();
      // Only 3 examples shown
      const exampleLines = infos.filter((msg: string) =>
        /spawn codex (sprite|hetzner|vultr|linode)/.test(msg)
      );
      expect(exampleLines.length).toBe(3);
      // Truncation hint present
      expect(infos.some((msg: string) => msg.includes("to see all") && msg.includes("4"))).toBe(true);
    });
  });
});
