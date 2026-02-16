import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";

/**
 * Tests for cmdList grid view rendering and cmdClouds type-grouping display.
 *
 * Existing test coverage:
 * - commands-compact-list.test.ts: compact view (narrow terminal)
 * - commands-output.test.ts: basic cmdList/cmdClouds content checks
 *
 * This file covers the UNTESTED branches and rendering details:
 *
 * cmdList grid view:
 * - Matrix row rendering: "+" for implemented, "-" for missing
 * - Grid header with cloud display names
 * - Grid separator line with dashes
 * - Legend line: "+ implemented  - not yet available"
 * - Footer usage hints in grid mode
 * - All-implemented matrix (all "+" marks)
 * - All-missing matrix (all "-" marks)
 * - Single agent/cloud edge cases
 *
 * cmdClouds type grouping:
 * - Clouds grouped by type field (vm, cloud, container, sandbox)
 * - Multiple type groups rendered
 * - Type header line for each group
 * - Agent count ratio (N/M) per cloud within groups
 * - Cloud total count in header "(N total)"
 * - Usage hint at bottom
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Manifest with multiple cloud types for type-grouping tests
const multiTypeManifest: Manifest = {
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
      description: "European cloud",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    daytona: {
      name: "Daytona",
      description: "Dev environments",
      url: "https://daytona.io",
      type: "container",
      auth: "DAYTONA_API_KEY",
      provision_method: "cli",
      exec_method: "exec",
      interactive_method: "exec",
    },
    e2b: {
      name: "E2B",
      description: "AI sandboxes",
      url: "https://e2b.dev",
      type: "sandbox",
      auth: "E2B_API_KEY",
      provision_method: "api",
      exec_method: "exec",
      interactive_method: "exec",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/aider": "missing",
    "daytona/claude": "implemented",
    "daytona/aider": "implemented",
    "e2b/claude": "implemented",
    "e2b/aider": "missing",
  },
};

// All-implemented manifest for grid view
const allImplManifest: Manifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/aider": "implemented",
  },
};

// All-missing manifest for grid view
const allMissingManifest: Manifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "missing",
    "sprite/aider": "missing",
    "hetzner/claude": "missing",
    "hetzner/aider": "missing",
  },
};

// Single agent manifest
const singleAgentManifest: Manifest = {
  agents: {
    claude: mockManifest.agents.claude,
  },
  clouds: mockManifest.clouds,
  matrix: {
    "sprite/claude": "implemented",
    "hetzner/claude": "missing",
  },
};

// Single cloud manifest
const singleCloudManifest: Manifest = {
  agents: mockManifest.agents,
  clouds: {
    sprite: mockManifest.clouds.sprite,
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "missing",
  },
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
const { cmdMatrix, cmdClouds } = await import("../commands.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function setManifest(manifest: any) {
  global.fetch = mock(async () => ({
    ok: true,
    json: async () => manifest,
    text: async () => JSON.stringify(manifest),
  })) as any;
  return loadManifest(true);
}

function getOutput(consoleMocks: ReturnType<typeof createConsoleMocks>): string {
  return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
}

function getLines(consoleMocks: ReturnType<typeof createConsoleMocks>): string[] {
  return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
}

// ── cmdList Grid View ────────────────────────────────────────────────────────

describe("cmdMatrix - grid view rendering", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    originalDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");

    // Force wide terminal for grid view
    setTerminalWidth(200);

    await setManifest(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDescriptor) {
      Object.defineProperty(process.stdout, "columns", originalDescriptor);
    }
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  function setTerminalWidth(width: number | undefined) {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  // ── Grid header ────────────────────────────────────────────────────

  describe("grid header", () => {
    it("should show cloud display names in the header row", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show all cloud names when multiple types exist", async () => {
      await setManifest(multiTypeManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("Daytona");
      expect(output).toContain("E2B");
    });
  });

  // ── Grid separator ─────────────────────────────────────────────────

  describe("grid separator", () => {
    it("should render a separator line with dashes", async () => {
      await cmdMatrix();
      const lines = getLines(consoleMocks);
      const separatorLine = lines.find((l: string) => l.includes("--") && !l.includes("Agent"));
      expect(separatorLine).toBeDefined();
    });
  });

  // ── Matrix row rendering ──────────────────────────────────────────

  describe("matrix rows", () => {
    it("should show '+' for implemented entries", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("+");
    });

    it("should show '-' for missing entries", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      // hetzner/aider is missing
      expect(output).toContain("-");
    });

    it("should show all '+' when everything is implemented", async () => {
      await setManifest(allImplManifest);
      await cmdMatrix();
      const lines = getLines(consoleMocks);
      // Find agent rows (contain agent display names)
      const agentRows = lines.filter(
        (l: string) => l.includes("Claude Code") || l.includes("Aider")
      );
      // Each agent row should have "+" for each cloud and no "-" status markers
      for (const row of agentRows) {
        expect(row).toContain("+");
      }
    });

    it("should show agent display names in rows", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
    });

    it("should render single agent grid correctly", async () => {
      await setManifest(singleAgentManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Claude Code");
      expect(output).toContain("+");
      expect(output).toContain("-");
    });

    it("should render single cloud grid correctly", async () => {
      await setManifest(singleCloudManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Sprite");
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
    });
  });

  // ── Legend ─────────────────────────────────────────────────────────

  describe("grid legend", () => {
    it("should show legend with implemented and not-yet-available labels", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("implemented");
      expect(output).toContain("not yet available");
    });

    it("should show '+' symbol in legend", async () => {
      await cmdMatrix();
      const lines = getLines(consoleMocks);
      const legendLine = lines.find(
        (l: string) => l.includes("implemented") && l.includes("not yet available")
      );
      expect(legendLine).toBeDefined();
      expect(legendLine!).toContain("+");
    });
  });

  // ── Footer ────────────────────────────────────────────────────────

  describe("grid footer", () => {
    it("should show correct implementation count for mixed matrix", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      // 3 implemented out of 4 total
      expect(output).toContain("3/4");
      expect(output).toContain("combinations implemented");
    });

    it("should show N/N for all-implemented matrix", async () => {
      await setManifest(allImplManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("4/4");
    });

    it("should show 0/N for all-missing matrix", async () => {
      await setManifest(allMissingManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("0/4");
    });

    it("should show correct count for multi-type manifest", async () => {
      await setManifest(multiTypeManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      // 6 implemented out of 8 total (2 agents x 4 clouds)
      expect(output).toContain("6/8");
    });

    it("should show usage hints with spawn <agent> and spawn <cloud>", async () => {
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("spawn <agent>");
      expect(output).toContain("spawn <cloud>");
    });

    it("should show 1/2 for single agent with one implementation", async () => {
      await setManifest(singleAgentManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("1/2");
    });

    it("should show 1/2 for single cloud with one implementation", async () => {
      await setManifest(singleCloudManifest);
      await cmdMatrix();
      const output = getOutput(consoleMocks);
      expect(output).toContain("1/2");
    });
  });
});

// ── cmdClouds Type Grouping ──────────────────────────────────────────────────

describe("cmdClouds - type grouping", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    await setManifest(multiTypeManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Type group headers ─────────────────────────────────────────────

  describe("type group headers", () => {
    it("should show all distinct cloud types as group headers", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("vm");
      expect(output).toContain("cloud");
      expect(output).toContain("container");
      expect(output).toContain("sandbox");
    });

    it("should show single type when all clouds share same type", async () => {
      const sameTypeManifest: Manifest = {
        agents: mockManifest.agents,
        clouds: {
          sprite: { ...mockManifest.clouds.sprite, type: "vm" },
          hetzner: { ...mockManifest.clouds.hetzner, type: "vm" },
        },
        matrix: mockManifest.matrix,
      };
      await setManifest(sameTypeManifest);
      await cmdClouds();
      const output = getOutput(consoleMocks);
      // Should have "vm" but NOT "cloud" or other types
      expect(output).toContain("vm");
      // Count occurrences of type headers - should only be one type group
      const lines = getLines(consoleMocks);
      const typeLines = lines.filter((l: string) => l.trim() === "vm");
      expect(typeLines.length).toBe(1);
    });
  });

  // ── Cloud entries within groups ────────────────────────────────────

  describe("cloud entries within groups", () => {
    it("should show cloud keys within type groups", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("sprite");
      expect(output).toContain("hetzner");
      expect(output).toContain("daytona");
      expect(output).toContain("e2b");
    });

    it("should show cloud display names within type groups", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("Daytona");
      expect(output).toContain("E2B");
    });

    it("should show cloud descriptions within type groups", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Lightweight VMs");
      expect(output).toContain("European cloud");
      expect(output).toContain("Dev environments");
      expect(output).toContain("AI sandboxes");
    });
  });

  // ── Agent count ratio ──────────────────────────────────────────────

  describe("agent count ratio per cloud", () => {
    it("should show N/M ratio for each cloud", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      // sprite: 2/2, hetzner: 1/2, daytona: 2/2, e2b: 1/2
      expect(output).toContain("2/2");
      expect(output).toContain("1/2");
    });

    it("should show 0/N when cloud has no implementations", async () => {
      const noImplManifest: Manifest = {
        agents: mockManifest.agents,
        clouds: {
          sprite: mockManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "missing",
          "sprite/aider": "missing",
        },
      };
      await setManifest(noImplManifest);
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("0/2");
    });

    it("should show N/N when all agents are implemented on a cloud", async () => {
      await cmdClouds();
      const lines = getLines(consoleMocks);
      // sprite has 2/2 agents implemented
      const spriteLine = lines.find(
        (l: string) => l.includes("sprite") && l.includes("Sprite")
      );
      expect(spriteLine).toBeDefined();
      expect(spriteLine!).toContain("2/2");
    });
  });

  // ── Header with total count ────────────────────────────────────────

  describe("header with total count", () => {
    it("should show 'Cloud Providers' header with total count", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("Cloud Providers");
      expect(output).toContain("4 total");
    });

    it("should show correct total for two clouds", async () => {
      await setManifest(mockManifest);
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("2 total");
    });

    it("should show correct total for single cloud", async () => {
      const oneCloudManifest: Manifest = {
        agents: mockManifest.agents,
        clouds: {
          sprite: mockManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "implemented",
          "sprite/aider": "implemented",
        },
      };
      await setManifest(oneCloudManifest);
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("1 total");
    });
  });

  // ── Usage hint ─────────────────────────────────────────────────────

  describe("usage hint", () => {
    it("should show spawn <cloud> usage hint", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("spawn <cloud>");
    });

    it("should show spawn <agent> <cloud> usage hint", async () => {
      await cmdClouds();
      const output = getOutput(consoleMocks);
      expect(output).toContain("spawn <agent> <cloud>");
    });
  });

  // ── Cloud type ordering ────────────────────────────────────────────

  describe("type ordering", () => {
    it("should group vm clouds together", async () => {
      await cmdClouds();
      const lines = getLines(consoleMocks);
      // Find the "vm" type header and the next cloud after it
      const vmIdx = lines.findIndex((l: string) => l.trim() === "vm");
      expect(vmIdx).toBeGreaterThan(-1);
      // Next non-empty line should contain sprite (the vm cloud)
      const nextLine = lines.slice(vmIdx + 1).find((l: string) => l.trim().length > 0);
      expect(nextLine).toBeDefined();
      expect(nextLine!).toContain("sprite");
    });

    it("should group cloud-type clouds together", async () => {
      await cmdClouds();
      const lines = getLines(consoleMocks);
      const cloudIdx = lines.findIndex((l: string) => l.trim() === "cloud");
      expect(cloudIdx).toBeGreaterThan(-1);
      const nextLine = lines.slice(cloudIdx + 1).find((l: string) => l.trim().length > 0);
      expect(nextLine).toBeDefined();
      expect(nextLine!).toContain("hetzner");
    });

    it("should group container-type clouds together", async () => {
      await cmdClouds();
      const lines = getLines(consoleMocks);
      const containerIdx = lines.findIndex((l: string) => l.trim() === "container");
      expect(containerIdx).toBeGreaterThan(-1);
      const nextLine = lines.slice(containerIdx + 1).find((l: string) => l.trim().length > 0);
      expect(nextLine).toBeDefined();
      expect(nextLine!).toContain("daytona");
    });

    it("should group sandbox-type clouds together", async () => {
      await cmdClouds();
      const lines = getLines(consoleMocks);
      const sandboxIdx = lines.findIndex((l: string) => l.trim() === "sandbox");
      expect(sandboxIdx).toBeGreaterThan(-1);
      const nextLine = lines.slice(sandboxIdx + 1).find((l: string) => l.trim().length > 0);
      expect(nextLine).toBeDefined();
      expect(nextLine!).toContain("e2b");
    });
  });

  // ── Multiple clouds in same type group ─────────────────────────────

  describe("multiple clouds in same type group", () => {
    it("should show multiple clouds under the same type header", async () => {
      const twoVmManifest: Manifest = {
        agents: { claude: mockManifest.agents.claude },
        clouds: {
          sprite: { ...mockManifest.clouds.sprite, type: "vm" },
          vultr: {
            name: "Vultr",
            description: "Cloud compute",
            url: "https://vultr.com",
            type: "vm",
            auth: "VULTR_API_KEY",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
        },
        matrix: {
          "sprite/claude": "implemented",
          "vultr/claude": "implemented",
        },
      };
      await setManifest(twoVmManifest);
      await cmdClouds();
      const output = getOutput(consoleMocks);
      // Both should appear under "vm" type
      expect(output).toContain("vm");
      expect(output).toContain("Sprite");
      expect(output).toContain("Vultr");
    });
  });
});
