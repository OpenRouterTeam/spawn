import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for command output functions (cmdList, cmdAgents, cmdClouds, cmdAgentInfo, cmdHelp).
 *
 * Strategy: mock @clack/prompts to prevent TTY output, and mock global.fetch
 * so that loadManifest returns controlled test data. Before each test, we call
 * loadManifest(true) to force a cache refresh through our mocked fetch.
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts to prevent TTY output
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import commands after @clack/prompts mock is set up
const { cmdMatrix, cmdAgents, cmdClouds, cmdAgentInfo, cmdHelp } = await import("../commands.js");

describe("Command Output Functions", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    // Mock fetch to return our controlled manifest data
    originalFetch = global.fetch;
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;

    // Force-refresh the manifest cache so it picks up our mocked fetch data.
    // This ensures the in-memory _cached in manifest.ts is set to our test data,
    // regardless of what other test files may have loaded before us.
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── cmdList ─────────────────────────────────────────────────────────────

  describe("cmdMatrix", () => {
    it("should load manifest and display matrix table", async () => {
      await cmdMatrix();
      expect(consoleMocks.log).toHaveBeenCalled();
    });

    it("should show agent names in the matrix", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
    });

    it("should show cloud names in the header", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show implementation count", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // 3 implemented out of 4 total (2 agents x 2 clouds)
      expect(output).toContain("3/4");
    });

    it("should show legend with implemented and not-yet-available labels", async () => {
      await cmdMatrix();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("implemented");
      expect(output).toContain("not yet available");
    });

    it("should use spinner while loading", async () => {
      await cmdMatrix();
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalled();
    });
  });

  // ── cmdAgents ───────────────────────────────────────────────────────────

  describe("cmdAgents", () => {
    it("should load manifest and display agents", async () => {
      await cmdAgents();
      expect(consoleMocks.log).toHaveBeenCalled();
    });

    it("should show all agent keys", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("claude");
      expect(output).toContain("aider");
    });

    it("should show agent display names", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
    });

    it("should show cloud count per agent", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // claude has 2 clouds (sprite, hetzner), aider has 1 (sprite)
      expect(output).toContain("2 clouds");
      expect(output).toContain("1 cloud");
      expect(output).not.toContain("1 clouds");
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

    it("should show Agents header", async () => {
      await cmdAgents();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Agents");
    });
  });

  // ── cmdClouds ───────────────────────────────────────────────────────────

  describe("cmdClouds", () => {
    it("should load manifest and display clouds", async () => {
      await cmdClouds();
      expect(consoleMocks.log).toHaveBeenCalled();
    });

    it("should show all cloud keys", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("sprite");
      expect(output).toContain("hetzner");
    });

    it("should show cloud display names", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show agent count per cloud", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // sprite has 2 agents (claude, aider), hetzner has 1 (claude) - shown as X/Y ratio
      expect(output).toContain("2/2");
      expect(output).toContain("1/2");
    });

    it("should show cloud descriptions", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Lightweight VMs");
      expect(output).toContain("European cloud provider");
    });

    it("should show Cloud Providers header", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Cloud Providers");
    });

    it("should show usage hint at bottom", async () => {
      await cmdClouds();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn <agent> <cloud>");
    });
  });

  // ── cmdAgentInfo ────────────────────────────────────────────────────────

  describe("cmdAgentInfo", () => {
    it("should show agent name and description", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("AI coding assistant");
    });

    it("should show Available clouds header", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Available clouds");
    });

    it("should list implemented clouds for claude", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("sprite");
      expect(output).toContain("hetzner");
    });

    it("should show launch command hint for each cloud", async () => {
      await cmdAgentInfo("claude");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn claude sprite");
      expect(output).toContain("spawn claude hetzner");
    });

    it("should only show implemented clouds for aider", async () => {
      await cmdAgentInfo("aider");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("sprite");
      // hetzner/aider is "missing" in mock manifest
      expect(output).not.toContain("spawn aider hetzner");
    });

    it("should show aider description", async () => {
      await cmdAgentInfo("aider");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Aider");
      expect(output).toContain("AI pair programmer");
    });
  });

  // ── cmdHelp ─────────────────────────────────────────────────────────────

  describe("cmdHelp output content", () => {
    it("should include all subcommand names", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("list");
      expect(output).toContain("agents");
      expect(output).toContain("clouds");
      expect(output).toContain("update");
      expect(output).toContain("version");
      expect(output).toContain("help");
    });

    it("should include USAGE section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("USAGE");
    });

    it("should include EXAMPLES section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("EXAMPLES");
    });

    it("should include AUTHENTICATION section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("AUTHENTICATION");
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should include TROUBLESHOOTING section", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("TROUBLESHOOTING");
    });

    it("should include --prompt and --prompt-file usage", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("--prompt");
      expect(output).toContain("--prompt-file");
    });

    it("should include repo and OpenRouter links", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("openrouter.ai");
      expect(output).toContain("github.com");
    });

    it("should include install command", () => {
      cmdHelp();
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("curl -fsSL");
      expect(output).toContain("install.sh");
    });
  });
});
