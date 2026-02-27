import type { spyOn } from "bun:test";
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Manifest } from "../manifest";
import { loadManifest } from "../manifest";
import { createConsoleMocks, restoreMocks } from "./test-helpers";

/**
 * Tests for cmdMatrix, cmdAgents, and cmdClouds listing command output.
 *
 * These three commands produce user-facing listing output with:
 * - cmdMatrix: grid (wide terminal) or compact (narrow terminal) view
 * - cmdAgents: agent list with implementation counts
 * - cmdClouds: cloud list grouped by type with agent counts
 *
 * Existing coverage:
 * - commands-display.test.ts: basic happy-path calls for cmdAgents/cmdClouds
 * - commands-compact-list.test.ts: compact view display at a high level
 * - commands-list-grid.test.ts: grid rendering helpers at a high level
 *
 * This file tests the ACTUAL exported functions end-to-end with controlled
 * manifests, verifying specific output content for:
 * - cmdMatrix grid view: header, separator, row icons (+/-), footer stats
 * - cmdMatrix compact view: agent name, count/total, missing cloud list
 * - cmdMatrix footer: implemented count, launch hint
 * - cmdAgents: agent keys, display names, implementation counts, footer hint
 * - cmdClouds: cloud keys, display names, type grouping, auth hints, footer
 * - Edge cases: empty manifest, single entry, all implemented, none implemented
 *
 * Agent: test-engineer
 */

// ── Mock manifests ──────────────────────────────────────────────────────────

const smallManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: {
        ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY",
      },
    },
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
      env: {
        OPENAI_API_KEY: "$OPENROUTER_API_KEY",
      },
    },
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
      url: "https://sprite.sh",
      type: "vm",
      auth: "SPRITE_TOKEN",
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
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/codex": "missing",
  },
};

const allImplementedManifest: Manifest = {
  agents: {
    claude: smallManifest.agents.claude,
    codex: smallManifest.agents.codex,
  },
  clouds: {
    sprite: smallManifest.clouds.sprite,
    hetzner: smallManifest.clouds.hetzner,
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/codex": "implemented",
  },
};

const multiTypeManifest: Manifest = {
  agents: {
    claude: smallManifest.agents.claude,
  },
  clouds: {
    sprite: {
      ...smallManifest.clouds.sprite,
      type: "vm",
    },
    hetzner: {
      ...smallManifest.clouds.hetzner,
      type: "cloud",
    },
    local: {
      name: "Local Machine",
      description: "Run agents on your own machine",
      url: "",
      type: "local",
      auth: "none",
      provision_method: "local",
      exec_method: "local",
      interactive_method: "local",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "hetzner/claude": "implemented",
    "local/claude": "implemented",
  },
};

// ── Mock @clack/prompts ─────────────────────────────────────────────────────

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

const { cmdMatrix, cmdAgents, cmdClouds, getTerminalWidth } = await import("../commands.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function setManifest(manifest: Manifest) {
  global.fetch = mock(async () => new Response(JSON.stringify(manifest)));
  return loadManifest(true);
}

function captureOutput(consoleMock: ReturnType<typeof spyOn>): string {
  return consoleMock.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
}

// ── cmdMatrix tests ──────────────────────────────────────────────────────────

describe("cmdMatrix output", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  describe("header and title", () => {
    it("should display 'Availability Matrix' title", async () => {
      await setManifest(smallManifest);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Availability Matrix");
    });

    it("should display agent and cloud counts in title", async () => {
      await setManifest(smallManifest);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("2 agents");
      expect(output).toContain("2 clouds");
    });
  });

  describe("footer statistics", () => {
    it("should display implemented count out of total", async () => {
      await setManifest(smallManifest);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      // 3 implemented out of 4 total (2 agents * 2 clouds)
      expect(output).toContain("3/4 combinations implemented");
    });

    it("should display all combinations when fully implemented", async () => {
      await setManifest(allImplementedManifest);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("4/4 combinations implemented");
    });

    it("should display launch command hint", async () => {
      await setManifest(smallManifest);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("spawn <agent> <cloud>");
    });
  });

  describe("grid view (wide terminal)", () => {
    it("should display cloud names in header row", async () => {
      await setManifest(smallManifest);

      // Force wide terminal for grid view
      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 200,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should display agent names in row labels", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 200,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Claude Code");
      expect(output).toContain("Codex");
    });

    it("should use + icon for implemented combinations", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 200,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("+");
    });

    it("should use - icon for missing combinations", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 200,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("-");
    });

    it("should display grid legend in footer", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 200,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("implemented");
      expect(output).toContain("not yet available");
    });
  });

  describe("compact view (narrow terminal)", () => {
    it("should display compact view when terminal is narrow", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      // Force very narrow terminal to trigger compact view
      Object.defineProperty(process.stdout, "columns", {
        value: 40,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      // Compact view shows "Agent" header and "Clouds" count column
      expect(output).toContain("Agent");
      expect(output).toContain("Clouds");
    });

    it("should show count/total for each agent in compact view", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 40,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      // claude: 2/2, codex: 1/2
      expect(output).toContain("2/2");
      expect(output).toContain("1/2");
    });

    it("should show 'all clouds supported' for fully implemented agent", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 40,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      // claude is implemented on both clouds
      expect(output).toContain("all clouds supported");
    });

    it("should show missing cloud names for partially implemented agent", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 40,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      // codex is missing on hetzner
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show compact legend in footer", async () => {
      await setManifest(smallManifest);

      const origColumns = process.stdout.columns;
      Object.defineProperty(process.stdout, "columns", {
        value: 40,
        configurable: true,
      });

      await cmdMatrix();

      Object.defineProperty(process.stdout, "columns", {
        value: origColumns,
        configurable: true,
      });

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("green");
      expect(output).toContain("yellow");
    });
  });

  describe("edge cases", () => {
    it("should handle single agent and single cloud", async () => {
      const singleManifest: Manifest = {
        agents: {
          claude: smallManifest.agents.claude,
        },
        clouds: {
          sprite: smallManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "implemented",
        },
      };

      await setManifest(singleManifest);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("1 agent");
      expect(output).toContain("1 cloud");
      expect(output).toContain("1/1 combinations implemented");
    });

    it("should handle manifest where nothing is implemented", async () => {
      const noneImplemented: Manifest = {
        agents: {
          claude: smallManifest.agents.claude,
        },
        clouds: {
          sprite: smallManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "missing",
        },
      };

      await setManifest(noneImplemented);
      await cmdMatrix();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("0/1 combinations implemented");
    });
  });
});

// ── cmdAgents tests ──────────────────────────────────────────────────────────

describe("cmdAgents output", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  describe("agent listing", () => {
    it("should display agent count in title", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Agents");
      expect(output).toContain("2 total");
    });

    it("should display all agent keys", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("claude");
      expect(output).toContain("codex");
    });

    it("should display agent display names", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Claude Code");
      expect(output).toContain("Codex");
    });

    it("should display implementation cloud count for each agent", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      // claude is implemented on 2 clouds
      expect(output).toContain("2 clouds");
      // codex is implemented on 1 cloud
      expect(output).toContain("1 cloud");
    });

    it("should use singular 'cloud' for count of 1", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      // codex has 1 cloud - should use singular
      expect(output).toMatch(/1 cloud[^s]/);
    });

    it("should display agent descriptions", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("AI coding assistant");
      expect(output).toContain("AI pair programmer");
    });

    it("should display footer with usage hints", async () => {
      await setManifest(smallManifest);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("spawn <agent>");
      expect(output).toContain("spawn <agent> <cloud>");
    });
  });

  describe("edge cases", () => {
    it("should handle single agent", async () => {
      const singleAgent: Manifest = {
        agents: {
          claude: smallManifest.agents.claude,
        },
        clouds: {
          sprite: smallManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "implemented",
        },
      };

      await setManifest(singleAgent);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("1 total");
      expect(output).toContain("claude");
    });

    it("should show 0 clouds for agent with no implementations", async () => {
      const noImpl: Manifest = {
        agents: {
          claude: smallManifest.agents.claude,
        },
        clouds: {
          sprite: smallManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "missing",
        },
      };

      await setManifest(noImpl);
      await cmdAgents();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("0 clouds");
    });
  });
});

// ── cmdClouds tests ──────────────────────────────────────────────────────────

describe("cmdClouds output", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  describe("cloud listing", () => {
    it("should display cloud count in title", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Cloud Providers");
      expect(output).toContain("2 total");
    });

    it("should display all cloud keys", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("sprite");
      expect(output).toContain("hetzner");
    });

    it("should display cloud display names", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should display cloud descriptions", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("Lightweight VMs");
      expect(output).toContain("European cloud provider");
    });

    it("should display implementation count as fraction", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      // sprite has 2/2 agents, hetzner has 1/2
      expect(output).toContain("2/2");
      expect(output).toContain("1/2");
    });

    it("should display auth hints for clouds with env var auth", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("needs");
      expect(output).toContain("SPRITE_TOKEN");
      expect(output).toContain("HCLOUD_TOKEN");
    });

    it("should display footer with usage hints", async () => {
      await setManifest(smallManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("spawn <cloud>");
      expect(output).toContain("spawn <agent> <cloud>");
    });
  });

  describe("type grouping", () => {
    it("should group clouds by type", async () => {
      await setManifest(multiTypeManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("vm");
      expect(output).toContain("cloud");
      expect(output).toContain("local");
    });

    it("should display clouds under their correct type group", async () => {
      await setManifest(multiTypeManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      // Sprite should appear in the output (type: vm)
      expect(output).toContain("Sprite");
      // Hetzner should appear (type: cloud)
      expect(output).toContain("Hetzner Cloud");
      // Local Machine should appear (type: local)
      expect(output).toContain("Local Machine");
    });

    it("should not display auth hint for clouds with auth 'none'", async () => {
      await setManifest(multiTypeManifest);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      // The local cloud has auth: "none" - should not show "auth: none" as a hint
      // Find lines containing "Local Machine" and check they don't have auth: none
      const lines = output.split("\n");
      const localLine = lines.find((l) => l.includes("Local Machine"));
      expect(localLine).toBeDefined();
      expect(localLine).not.toContain("auth:");
    });
  });

  describe("edge cases", () => {
    it("should handle single cloud", async () => {
      const singleCloud: Manifest = {
        agents: {
          claude: smallManifest.agents.claude,
        },
        clouds: {
          sprite: smallManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "implemented",
        },
      };

      await setManifest(singleCloud);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("1 total");
    });

    it("should show 0/N for cloud with no implementations", async () => {
      const noImpl: Manifest = {
        agents: {
          claude: smallManifest.agents.claude,
          codex: smallManifest.agents.codex,
        },
        clouds: {
          sprite: smallManifest.clouds.sprite,
        },
        matrix: {
          "sprite/claude": "missing",
          "sprite/codex": "missing",
        },
      };

      await setManifest(noImpl);
      await cmdClouds();

      const output = captureOutput(consoleMocks.log);
      expect(output).toContain("0/2");
    });
  });
});

// ── Cross-command consistency tests ──────────────────────────────────────────

describe("listing command consistency", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("cmdAgents count should match cmdMatrix agent count", async () => {
    await setManifest(smallManifest);

    await cmdAgents();
    const agentsOutput = captureOutput(consoleMocks.log);
    restoreMocks(consoleMocks.log, consoleMocks.error);

    consoleMocks = createConsoleMocks();
    await cmdMatrix();
    const matrixOutput = captureOutput(consoleMocks.log);

    // Both should mention 2 agents
    expect(agentsOutput).toContain("2 total");
    expect(matrixOutput).toContain("2 agents");
  });

  it("cmdClouds count should match cmdMatrix cloud count", async () => {
    await setManifest(smallManifest);

    await cmdClouds();
    const cloudsOutput = captureOutput(consoleMocks.log);
    restoreMocks(consoleMocks.log, consoleMocks.error);

    consoleMocks = createConsoleMocks();
    await cmdMatrix();
    const matrixOutput = captureOutput(consoleMocks.log);

    // Both should mention 2 clouds
    expect(cloudsOutput).toContain("2 total");
    expect(matrixOutput).toContain("2 clouds");
  });

  it("cmdMatrix implemented count should be consistent", async () => {
    await setManifest(smallManifest);
    await cmdMatrix();
    const output = captureOutput(consoleMocks.log);

    // 3 implemented: sprite/claude, sprite/codex, hetzner/claude
    // 1 missing: hetzner/codex
    // Total: 4 combinations
    expect(output).toContain("3/4 combinations implemented");
  });
});
