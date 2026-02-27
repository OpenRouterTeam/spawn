import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for display/output commands: cmdAgentInfo (happy path) and cmdHelp.
 *
 * Listing command tests (cmdMatrix, cmdAgents, cmdClouds) live in
 * cmd-listing-output.test.ts which provides thorough end-to-end coverage.
 *
 * Existing tests cover:
 * - cmdMatrix, cmdAgents, cmdClouds: cmd-listing-output.test.ts
 * - cmdAgentInfo error paths (commands-error-paths.test.ts)
 * - cmdCloudInfo full coverage (commands-cloud-info.test.ts)
 * - cmdRun validation and error paths (commands-error-paths.test.ts)
 * - cmdUpdate: commands-update-download.test.ts
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
const { cmdAgentInfo, cmdHelp } = await import("../commands.js");

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
});
