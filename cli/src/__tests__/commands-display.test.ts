import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for display/output commands: cmdAgentInfo (happy path), cmdList,
 * cmdAgents, cmdClouds, cmdHelp, and cmdUpdate error paths.
 *
 * Existing tests cover:
 * - cmdAgentInfo error paths (commands-error-paths.test.ts)
 * - cmdCloudInfo full coverage (commands-cloud-info.test.ts)
 * - cmdRun validation and error paths (commands-error-paths.test.ts)
 *
 * This file covers the UNTESTED happy paths and output formatting of:
 * - cmdAgentInfo: displaying agent details and available clouds
 * - cmdList: rendering the full matrix table
 * - cmdAgents: listing all agents with cloud counts
 * - cmdClouds: listing all clouds with agent counts
 * - cmdHelp: verifying help output content
 * - cmdUpdate: version check and error handling paths
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Manifest with no implementations for edge case testing
const noImplManifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "missing",
    "sprite/codex": "missing",
    "hetzner/claude": "missing",
    "hetzner/codex": "missing",
  },
};

// Manifest with a single implementation
const singleImplManifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "missing",
    "hetzner/claude": "missing",
    "hetzner/codex": "missing",
  },
};

// Manifest with many clouds (> 3) to test "see all" hint
const manyCloudManifest = {
  agents: {
    claude: mockManifest.agents.claude,
  },
  clouds: {
    sprite: mockManifest.clouds.sprite,
    hetzner: mockManifest.clouds.hetzner,
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
const { cmdAgentInfo, cmdMatrix, cmdAgents, cmdClouds, cmdHelp, cmdUpdate } = await import("../commands.js");

describe("Commands Display Output", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;
    global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));

    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── cmdAgentInfo happy path ────────────────────────────────────────

  describe("cmdAgentInfo - happy path", () => {
    it("should display agent name and description for claude", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("AI coding assistant");
    });

    it("should display Available clouds header", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Available clouds");
    });

    it("should list implemented clouds for claude", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // claude is implemented on both sprite and hetzner
      expect(output).toContain("sprite");
      expect(output).toContain("hetzner");
    });

    it("should show launch command hint for each cloud", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn claude sprite");
      expect(output).toContain("spawn claude hetzner");
    });

    it("should show codex agent info with only sprite cloud", async () => {
      await cmdAgentInfo("codex");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Codex");
      expect(output).toContain("AI pair programmer");
      expect(output).toContain("spawn codex sprite");
      expect(output).not.toContain("spawn codex hetzner");
    });

    it("should show no-clouds message when agent has no implementations", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(noImplManifest)));
      await loadManifest(true);

      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("No implemented clouds");
    });

    it("should use spinner while loading manifest", async () => {
      await cmdAgentInfo("claude");
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalled();
    });
  });

  // ── cmdList ────────────────────────────────────────────────────────

  describe("cmdMatrix", () => {
    it("should display cloud names in header", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should display agent names in rows", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("Codex");
    });

    it("should show implemented count", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // 3 implemented out of 4 total (2 agents x 2 clouds)
      expect(output).toContain("3/4");
    });

    it("should show legend for + and -", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("implemented");
      expect(output).toContain("not yet available");
    });

    it("should show + for implemented and - for missing", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("+");
      expect(output).toContain("-");
    });

    it("should show 0 implemented when nothing is implemented", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(noImplManifest)));
      await loadManifest(true);

      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("0/4");
    });

    it("should use spinner while loading manifest", async () => {
      await cmdMatrix();
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalled();
    });
  });

  // ── cmdAgents ──────────────────────────────────────────────────────

  describe("cmdAgents", () => {
    it("should display Agents header", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Agents");
    });

    it("should list all agents with their display names", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("claude");
      expect(output).toContain("Claude Code");
      expect(output).toContain("codex");
      expect(output).toContain("Codex");
    });

    it("should show cloud counts for each agent", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // claude has 2 clouds, codex has 1 cloud
      expect(output).toContain("2 clouds");
      expect(output).toContain("1 cloud");
    });

    it("should show correct singular/plural for cloud count", async () => {
      await cmdAgents();
      const calls = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      // Find the line with codex (1 cloud - singular)
      const codexLine = calls.find((line: string) => line.includes("codex") && line.includes("cloud"));
      expect(codexLine).toBeDefined();
      expect(codexLine).toContain("1 cloud");
      expect(codexLine).not.toContain("1 clouds");
    });

    it("should show agent descriptions", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("AI coding assistant");
      expect(output).toContain("AI pair programmer");
    });

    it("should show usage hint at bottom", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn <agent>");
    });
  });

  // ── cmdClouds ──────────────────────────────────────────────────────

  describe("cmdClouds", () => {
    it("should display Cloud Providers header", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Cloud Providers");
    });

    it("should list all clouds with their display names", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("sprite");
      expect(output).toContain("Sprite");
      expect(output).toContain("hetzner");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show agent counts for each cloud as ratio", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // sprite has 2/2 agents, hetzner has 1/2 agents - shown as X/Y ratio
      expect(output).toContain("2/2");
      expect(output).toContain("1/2");
    });

    it("should group clouds by type", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // Mock manifest has clouds with types "vm" and "cloud"
      expect(output).toContain("vm");
      expect(output).toContain("cloud");
    });

    it("should show cloud descriptions", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Lightweight VMs");
      expect(output).toContain("European cloud provider");
    });

    it("should show usage hint at bottom", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn <cloud>");
    });
  });

  // ── cmdHelp ────────────────────────────────────────────────────────

  describe("cmdHelp", () => {
    it("should display usage section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("USAGE");
    });

    it("should show all subcommands", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn list");
      expect(output).toContain("spawn agents");
      expect(output).toContain("spawn clouds");
      expect(output).toContain("spawn update");
      expect(output).toContain("spawn version");
      expect(output).toContain("spawn help");
    });

    it("should show examples section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("EXAMPLES");
    });

    it("should show authentication section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("AUTHENTICATION");
      expect(output).toContain("OpenRouter");
    });

    it("should show troubleshooting section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("TROUBLESHOOTING");
    });

    it("should show --prompt and --prompt-file usage", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("--prompt");
      expect(output).toContain("--prompt-file");
    });

    it("should mention SPAWN_NO_UNICODE env var", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("SPAWN_NO_UNICODE");
    });

    it("should show install section with curl command", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("INSTALL");
      expect(output).toContain("curl");
      expect(output).toContain("install.sh");
    });

    it("should show repository URL", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("OpenRouterTeam/spawn");
    });
  });

  // ── cmdUpdate ──────────────────────────────────────────────────────

  describe("cmdUpdate", () => {
    it("should show already up to date when versions match", async () => {
      const pkg = await import("../../package.json");
      global.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              version: pkg.default.version,
            }),
          ),
      );

      await cmdUpdate();

      // Spinner should have been used
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalled();
      // Stop message should mention "up to date"
      const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c.join(" "));
      expect(stopCalls.some((msg: string) => msg.includes("up to date"))).toBe(true);
    });

    it("should handle fetch failure gracefully", async () => {
      global.fetch = mock(async (): Promise<Response> => {
        throw new Error("Network timeout");
      });

      await cmdUpdate();

      // Should stop spinner with failure message
      expect(mockSpinnerStop).toHaveBeenCalled();
      // Should print error details
      const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(errorOutput).toContain("Network timeout");
    });

    it("should handle non-ok fetch response", async () => {
      global.fetch = mock(
        async () =>
          new Response("error", {
            status: 500,
          }),
      );

      await cmdUpdate();

      // Should stop spinner with failure message
      expect(mockSpinnerStop).toHaveBeenCalled();
    });
  });

  // ── cmdList with varied manifests ──────────────────────────────────

  describe("cmdList - edge cases", () => {
    it("should handle single implementation correctly", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(singleImplManifest)));
      await loadManifest(true);

      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("1/4");
    });

    it("should handle manifest with many clouds", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(manyCloudManifest)));
      await loadManifest(true);

      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // With many clouds, compact view is used when grid exceeds terminal width
      // All 5 clouds are implemented so it shows "all clouds supported"
      expect(output).toContain("Claude Code");
      expect(output).toContain("all clouds supported");
      // 5 out of 5 (1 agent x 5 clouds, all implemented)
      expect(output).toContain("5/5");
    });
  });

  // ── cmdAgentInfo cloud type display ─────────────────────────────────

  describe("cmdAgentInfo - cloud type display", () => {
    it("should show cloud type for each implemented cloud", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // sprite has type "vm", hetzner has type "cloud"
      expect(output).toContain("vm");
      expect(output).toContain("cloud");
    });

    it("should show agent notes when present", async () => {
      // Create a manifest with agent notes
      const manifestWithNotes = {
        ...mockManifest,
        agents: {
          ...mockManifest.agents,
          codex: {
            ...mockManifest.agents.codex,
            notes: "Natively supports OpenRouter",
          },
        },
      };
      global.fetch = mock(async () => new Response(JSON.stringify(manifestWithNotes)));
      await loadManifest(true);

      await cmdAgentInfo("codex");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Natively supports OpenRouter");
    });

    it("should not show notes line when agent has no notes", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // claude in mock manifest has no notes field
      expect(output).not.toContain("Natively supports");
    });
  });

  // ── cmdAgentInfo with many clouds ──────────────────────────────────

  describe("cmdAgentInfo - many clouds", () => {
    it("should list all implemented clouds for agent with many options", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(manyCloudManifest)));
      await loadManifest(true);

      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn claude sprite");
      expect(output).toContain("spawn claude hetzner");
      expect(output).toContain("spawn claude vultr");
      expect(output).toContain("spawn claude linode");
      expect(output).toContain("spawn claude digitalocean");
    });
  });

  // ── cmdAgents with no implementations ──────────────────────────────

  describe("cmdAgents - zero implementations", () => {
    it("should show 0 clouds for all agents", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(noImplManifest)));
      await loadManifest(true);

      await cmdAgents();
      const calls = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      // Both agents should show 0 clouds
      const agentLines = calls.filter((line: string) => line.includes("claude") || line.includes("codex"));
      for (const line of agentLines) {
        if (line.includes("cloud")) {
          expect(line).toContain("0 clouds");
        }
      }
    });
  });

  // ── cmdClouds with no implementations ──────────────────────────────

  describe("cmdClouds - zero implementations", () => {
    it("should show 0 agents for all clouds", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(noImplManifest)));
      await loadManifest(true);

      await cmdClouds();
      const calls = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      const cloudLines = calls.filter((line: string) => line.includes("sprite") || line.includes("hetzner"));
      for (const line of cloudLines) {
        if (line.includes("agent")) {
          expect(line).toContain("0 agents");
        }
      }
    });
  });
});
