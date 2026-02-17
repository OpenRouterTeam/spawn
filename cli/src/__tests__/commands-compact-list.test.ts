import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for the compact list view in cmdList (commands.ts lines 402-466).
 *
 * When the matrix grid would be wider than the terminal, cmdList falls back
 * to a compact view that shows each agent on one line with:
 *   - Agent name
 *   - Implemented cloud count (e.g. "3/5")
 *   - Missing clouds or "all clouds supported" when fully implemented
 *
 * This file tests:
 * - Compact view is triggered when grid exceeds terminal width
 * - Grid view is used when terminal is wide enough
 * - Compact header and separator rendering
 * - Per-agent count and missing cloud list
 * - "all clouds supported" display when agent is fully implemented
 * - Edge cases: all missing, single agent, many clouds
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Wide manifest with many clouds to trigger compact view
const wideManifest = {
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
    aws: {
      name: "AWS EC2",
      description: "Amazon cloud",
      url: "https://aws.amazon.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    gcp: {
      name: "Google Cloud",
      description: "Google cloud",
      url: "https://cloud.google.com",
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
    "aws/claude": "implemented",
    "gcp/claude": "implemented",
    "sprite/aider": "implemented",
    "hetzner/aider": "missing",
    "vultr/aider": "missing",
    "linode/aider": "implemented",
    "digitalocean/aider": "missing",
    "aws/aider": "missing",
    "gcp/aider": "missing",
  },
};

// All-missing manifest: no agent has any cloud implemented
const allMissingManifest = {
  agents: wideManifest.agents,
  clouds: wideManifest.clouds,
  matrix: Object.fromEntries(
    Object.keys(wideManifest.matrix).map((k) => [k, "missing"])
  ),
};

// All-implemented manifest: every combination is implemented
const allImplementedManifest = {
  agents: wideManifest.agents,
  clouds: wideManifest.clouds,
  matrix: Object.fromEntries(
    Object.keys(wideManifest.matrix).map((k) => [k, "implemented"])
  ),
};

// Mock @clack/prompts
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
    error: mock(() => {}),
    warn: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import commands after mock setup
const { cmdMatrix } = await import("../commands.js");

describe("Compact List View", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let originalColumns: number | undefined;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    originalColumns = process.stdout.columns;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalColumns !== undefined) {
      Object.defineProperty(process.stdout, 'columns', {
        value: originalColumns,
        writable: true,
        configurable: true
      });
    }
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  function setTerminalWidth(columns: number | undefined): void {
    Object.defineProperty(process.stdout, 'columns', {
      value: columns,
      writable: true,
      configurable: true
    });
  }

  // ── View switching based on terminal width ──────────────────────────

  describe("grid vs compact view switching", () => {
    it("should use compact view when terminal is narrow and many clouds", async () => {
      await setManifest(wideManifest);
      // Force narrow terminal - compact view triggered
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // Compact view has "Agent", "Clouds", "Not yet available" header columns
      expect(output).toContain("Agent");
      expect(output).toContain("Clouds");
      expect(output).toContain("Not yet available");
    });

    it("should use grid view when terminal is wide enough for small manifest", async () => {
      await setManifest(mockManifest);
      // Force wide terminal
      setTerminalWidth(200);

      await cmdMatrix();
      const output = getOutput();
      // Grid view shows + and - symbols and cloud names in header
      expect(output).toContain("+");
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
      // Grid view should NOT have the "Not yet available" header column
      expect(output).not.toContain("Not yet available");
    });

    it("should default to 80 columns when process.stdout.columns is undefined", async () => {
      await setManifest(wideManifest);
      // Simulate no tty (columns undefined)
      setTerminalWidth(undefined);

      await cmdMatrix();
      const output = getOutput();
      // With 7 clouds at ~10+ chars each, the grid would be ~100+ chars
      // which exceeds the 80-column default, so compact view should trigger
      expect(output).toContain("Agent");
      expect(output).toContain("Not yet available");
    });
  });

  // ── Compact view header and structure ─────────────────────────────

  describe("compact view header", () => {
    it("should show three column headers: Agent, Clouds, Not yet available", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      expect(output).toContain("Agent");
      expect(output).toContain("Clouds");
      expect(output).toContain("Not yet available");
    });

    it("should include a separator line with dashes", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // The separator is a line of dashes (at least 20 chars: NAME_WIDTH + COUNT_WIDTH + 20)
      expect(output).toContain("----------");
    });
  });

  // ── Count column rendering ────────────────────────────────────────

  describe("compact view counts", () => {
    it("should show correct count for fully implemented agent", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // claude is implemented on all 7 clouds -> "7/7"
      expect(output).toContain("7/7");
    });

    it("should show correct count for partially implemented agent", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // aider is implemented on sprite + linode = 2 out of 7
      expect(output).toContain("2/7");
    });

    it("should show 0/N when agent has no implementations", async () => {
      await setManifest(allMissingManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      expect(output).toContain("0/7");
    });

    it("should show N/N for all agents when everything is implemented", async () => {
      await setManifest(allImplementedManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // Both agents should show 7/7
      // Check that "7/7" appears (for both claude and aider)
      const matches = output.match(/7\/7/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(2);
    });
  });

  // ── Missing clouds column ─────────────────────────────────────────

  describe("compact view missing clouds column", () => {
    it("should show 'all clouds supported' when agent is fully implemented", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // claude is implemented everywhere -> "all clouds supported"
      expect(output).toContain("all clouds supported");
    });

    it("should list missing cloud names when agent is partially implemented", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // aider is missing: hetzner, vultr, digitalocean, aws, gcp
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("Vultr");
      expect(output).toContain("DigitalOcean");
      expect(output).toContain("AWS EC2");
      expect(output).toContain("Google Cloud");
    });

    it("should not list implemented clouds as missing", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // Find the line containing "Aider" to isolate the aider row
      const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      const aiderLine = lines.find(
        (line: string) => line.includes("Aider") && line.includes("/7")
      );
      expect(aiderLine).toBeDefined();
      // Sprite and Linode are implemented for aider, so they should NOT appear
      // as missing on the aider line
      // (But "Sprite" might appear in other lines, so check just the aider line)
      expect(aiderLine!).not.toContain("Sprite");
      expect(aiderLine!).not.toContain("Linode");
    });

    it("should list all clouds as missing when agent has no implementations", async () => {
      await setManifest(allMissingManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // All cloud names should appear in the missing column
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("Vultr");
      expect(output).toContain("Linode");
      expect(output).toContain("DigitalOcean");
      expect(output).toContain("AWS EC2");
      expect(output).toContain("Google Cloud");
    });

    it("should show 'all clouds supported' for every agent when everything is implemented", async () => {
      await setManifest(allImplementedManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      const allCloudsMatches = output.match(/all clouds supported/g);
      expect(allCloudsMatches).not.toBeNull();
      // Both agents fully implemented -> 2 "all clouds supported" + 1 in legend
      expect(allCloudsMatches!.length).toBe(3);
    });
  });

  // ── Agent names in compact view ───────────────────────────────────

  describe("compact view agent names", () => {
    it("should display agent display names (not keys)", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
    });
  });

  // ── Footer section (same in both views) ───────────────────────────

  describe("footer in compact view", () => {
    it("should show total implemented count", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      // claude: 7 implemented, aider: 2 implemented = 9 total out of 14
      expect(output).toContain("9/14");
    });

    it("should not show grid legend in compact view", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      expect(output).toContain("implemented");
      // The +/- legend is grid-only, not shown in compact view
      expect(output).not.toContain("+ implemented");
    });

    it("should show usage hints", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      expect(output).toContain("spawn <agent>");
      expect(output).toContain("spawn <cloud>");
    });
  });

  // ── Single agent manifest ─────────────────────────────────────────

  describe("compact view with single agent", () => {
    it("should render correctly with only one agent", async () => {
      const singleAgent = {
        agents: { claude: wideManifest.agents.claude },
        clouds: wideManifest.clouds,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "vultr/claude": "missing",
          "linode/claude": "missing",
          "digitalocean/claude": "missing",
          "aws/claude": "missing",
          "gcp/claude": "missing",
        },
      };
      await setManifest(singleAgent);
      setTerminalWidth(60);

      await cmdMatrix();
      const output = getOutput();
      expect(output).toContain("Claude Code");
      expect(output).toContain("2/7");
      expect(output).toContain("Vultr");
      expect(output).toContain("2/7 combinations implemented");
    });
  });

  // ── Missing clouds separator format ───────────────────────────────

  describe("compact view missing clouds formatting", () => {
    it("should separate missing cloud names with commas", async () => {
      await setManifest(wideManifest);
      setTerminalWidth(60);

      await cmdMatrix();
      const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      const aiderLine = lines.find(
        (line: string) => line.includes("Aider") && line.includes("/7")
      );
      expect(aiderLine).toBeDefined();
      // Missing clouds should be comma-separated
      expect(aiderLine!).toContain(", ");
    });
  });
});
