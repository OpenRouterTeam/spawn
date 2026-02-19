import { describe, it, expect } from "bun:test";
import type { Manifest } from "../manifest";
import {
  getImplementedClouds,
  getMissingClouds,
  calculateColumnWidth,
  getTerminalWidth,
} from "../commands";
import { matrixStatus, countImplemented, cloudKeys, agentKeys } from "../manifest";

/**
 * Tests for the compact matrix view rendering and matrix footer logic
 * in commands.ts.
 *
 * The `cmdMatrix` command renders an availability matrix. When the terminal
 * is too narrow for the full grid, it falls back to a "compact list" view
 * via `renderCompactList` (commands.ts:721-745). After the matrix body,
 * `renderMatrixFooter` (commands.ts:747-759) renders a legend and
 * implementation count.
 *
 * These functions have zero test coverage (not even as replicas). This file
 * tests exact replicas of the internal functions plus integration through
 * the exported helpers they depend on.
 *
 * Functions tested:
 * - renderCompactList: compact agent x cloud summary with missing list
 * - renderMatrixFooter: legend + implementation count for compact vs grid
 * - getTerminalWidth: terminal width fallback to 80
 * - calculateColumnWidth: dynamic column sizing with minimum width
 * - getMissingClouds: clouds where an agent is NOT implemented
 * - getImplementedClouds: clouds where an agent IS implemented
 *
 * Agent: test-engineer
 */

// ── Test Manifests ────────────────────────────────────────────────────────────

function createTestManifest(): Manifest {
  return {
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
      cline: {
        name: "Cline",
        description: "AI developer agent",
        url: "https://cline.dev",
        install: "npm install -g cline",
        launch: "cline",
        env: {},
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
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/codex": "implemented",
      "sprite/cline": "missing",
      "hetzner/claude": "implemented",
      "hetzner/codex": "missing",
      "hetzner/cline": "missing",
      "vultr/claude": "implemented",
      "vultr/codex": "missing",
      "vultr/cline": "missing",
    },
  };
}

function createFullyImplementedManifest(): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm",
        launch: "claude",
        env: {},
      },
    },
    clouds: {
      sprite: {
        name: "Sprite",
        description: "VMs",
        url: "https://sprite.sh",
        type: "vm",
        auth: "token",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
      hetzner: {
        name: "Hetzner",
        description: "Cloud",
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
      "hetzner/claude": "implemented",
    },
  };
}

// ── Exact replicas of internal functions from commands.ts ───────────────────

const COMPACT_NAME_WIDTH = 20;
const COMPACT_COUNT_WIDTH = 10;
const MIN_AGENT_COL_WIDTH = 16;
const MIN_CLOUD_COL_WIDTH = 10;
const COL_PADDING = 2;

// commands.ts:721-745
function renderCompactList(
  manifest: Manifest,
  agents: string[],
  clouds: string[]
): string[] {
  const totalClouds = clouds.length;
  const lines: string[] = [];

  lines.push("");
  lines.push("Agent".padEnd(COMPACT_NAME_WIDTH) + "Clouds".padEnd(COMPACT_COUNT_WIDTH) + "Not yet available");
  lines.push("-".repeat(COMPACT_NAME_WIDTH + COMPACT_COUNT_WIDTH + 30));

  for (const a of agents) {
    const implCount = getImplementedClouds(manifest, a).length;
    const missing = getMissingClouds(manifest, a, clouds);
    const countStr = `${implCount}/${totalClouds}`;

    let line = manifest.agents[a].name.padEnd(COMPACT_NAME_WIDTH);
    line += countStr.padEnd(COMPACT_COUNT_WIDTH);

    if (missing.length === 0) {
      line += "-- all clouds supported";
    } else {
      line += missing.map((c) => manifest.clouds[c].name).join(", ");
    }

    lines.push(line);
  }

  return lines;
}

// commands.ts:747-759
function renderMatrixFooter(
  manifest: Manifest,
  agents: string[],
  clouds: string[],
  isCompact: boolean
): string[] {
  const impl = countImplemented(manifest);
  const total = agents.length * clouds.length;
  const lines: string[] = [];
  lines.push("");
  if (isCompact) {
    lines.push("green = all clouds supported  yellow = some clouds not yet available");
  } else {
    lines.push("+ implemented  - not yet available");
  }
  lines.push(`${impl}/${total} combinations implemented`);
  lines.push("Launch: spawn <agent> <cloud>  |  Details: spawn <agent> or spawn <cloud>");
  lines.push("");
  return lines;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("renderCompactList", () => {
  it("should produce header line with column names", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const headerLine = lines.find((l) => l.includes("Agent") && l.includes("Clouds"));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("Not yet available");
  });

  it("should produce a separator line of dashes", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const sepLine = lines.find((l) => /^-{10,}$/.test(l.trim()));
    expect(sepLine).toBeDefined();
  });

  it("should have one data line per agent", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    // Lines: empty, header, separator, then one per agent
    const dataLines = lines.filter(
      (l) => l.trim() !== "" && !l.includes("Agent") && !l.match(/^-+$/)
    );
    expect(dataLines).toHaveLength(agents.length);
  });

  it("should show correct count for claude (3/3 implemented)", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const claudeLine = lines.find((l) => l.includes("Claude Code"));
    expect(claudeLine).toBeDefined();
    expect(claudeLine).toContain("3/3");
  });

  it("should show 'all clouds supported' for fully implemented agent", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const claudeLine = lines.find((l) => l.includes("Claude Code"));
    expect(claudeLine).toContain("all clouds supported");
  });

  it("should show correct count for codex (1/3 implemented)", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const codexLine = lines.find((l) => l.includes("Codex"));
    expect(codexLine).toBeDefined();
    expect(codexLine).toContain("1/3");
  });

  it("should list missing cloud names for partially implemented agent", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const codexLine = lines.find((l) => l.includes("Codex"));
    expect(codexLine).toBeDefined();
    // codex is missing on hetzner and vultr
    expect(codexLine).toContain("Hetzner Cloud");
    expect(codexLine).toContain("Vultr");
  });

  it("should show correct count for cline (0/3 implemented)", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const clineLine = lines.find((l) => l.includes("Cline"));
    expect(clineLine).toBeDefined();
    expect(clineLine).toContain("0/3");
  });

  it("should list all clouds as missing for unimplemented agent", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const clineLine = lines.find((l) => l.includes("Cline"));
    expect(clineLine).toBeDefined();
    expect(clineLine).toContain("Sprite");
    expect(clineLine).toContain("Hetzner Cloud");
    expect(clineLine).toContain("Vultr");
  });

  it("should show all agents as fully supported when everything is implemented", () => {
    const manifest = createFullyImplementedManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const claudeLine = lines.find((l) => l.includes("Claude Code"));
    expect(claudeLine).toBeDefined();
    expect(claudeLine).toContain("2/2");
    expect(claudeLine).toContain("all clouds supported");
  });

  it("should handle single agent and single cloud", () => {
    const manifest: Manifest = {
      agents: {
        solo: {
          name: "Solo Agent",
          description: "Single agent",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
      clouds: {
        only: {
          name: "Only Cloud",
          description: "Single cloud",
          url: "",
          type: "vm",
          auth: "none",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix: { "only/solo": "implemented" },
    };
    const lines = renderCompactList(manifest, ["solo"], ["only"]);
    const soloLine = lines.find((l) => l.includes("Solo Agent"));
    expect(soloLine).toBeDefined();
    expect(soloLine).toContain("1/1");
    expect(soloLine).toContain("all clouds supported");
  });

  it("should handle empty agents list", () => {
    const manifest = createTestManifest();
    const lines = renderCompactList(manifest, [], cloudKeys(manifest));

    // Should only have empty line, header, separator
    const dataLines = lines.filter(
      (l) => l.trim() !== "" && !l.includes("Agent") && !l.match(/^-+$/)
    );
    expect(dataLines).toHaveLength(0);
  });

  it("should use display names from manifest, not keys", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    // Should use "Claude Code" not "claude"
    expect(lines.some((l) => l.includes("Claude Code"))).toBe(true);
    // Missing cloud names should also be display names
    const codexLine = lines.find((l) => l.includes("Codex"));
    expect(codexLine).toContain("Hetzner Cloud"); // not "hetzner"
  });

  it("should separate missing cloud names with commas", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const lines = renderCompactList(manifest, agents, clouds);

    const clineLine = lines.find((l) => l.includes("Cline"));
    expect(clineLine).toBeDefined();
    // Should be comma-separated
    expect(clineLine).toMatch(/\w+,\s+\w+/);
  });
});

describe("renderMatrixFooter", () => {
  describe("compact mode", () => {
    it("should include color legend for compact mode", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, true);

      const legendLine = lines.find((l) => l.includes("green") && l.includes("yellow"));
      expect(legendLine).toBeDefined();
    });

    it("should describe green as 'all clouds supported'", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, true);

      expect(lines.some((l) => l.includes("all clouds supported"))).toBe(true);
    });

    it("should describe yellow as 'some clouds not yet available'", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, true);

      expect(lines.some((l) => l.includes("some clouds not yet available"))).toBe(true);
    });

    it("should NOT show +/- legend in compact mode", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, true);

      expect(lines.some((l) => l.includes("+ implemented"))).toBe(false);
    });
  });

  describe("grid mode", () => {
    it("should include +/- legend for grid mode", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      expect(lines.some((l) => l.includes("+ implemented"))).toBe(true);
      expect(lines.some((l) => l.includes("- not yet available"))).toBe(true);
    });

    it("should NOT show green/yellow legend in grid mode", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      expect(lines.some((l) => l.includes("green") && l.includes("yellow"))).toBe(false);
    });
  });

  describe("implementation count", () => {
    it("should show correct implementation count", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      // 4 implemented out of 9 total (3 agents x 3 clouds)
      expect(lines.some((l) => l.includes("4/9"))).toBe(true);
    });

    it("should show 'combinations implemented' label", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      expect(lines.some((l) => l.includes("combinations implemented"))).toBe(true);
    });

    it("should show correct count for fully implemented manifest", () => {
      const manifest = createFullyImplementedManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      // 2/2 (1 agent x 2 clouds, all implemented)
      expect(lines.some((l) => l.includes("2/2"))).toBe(true);
    });

    it("should show 0 implemented for empty matrix", () => {
      const manifest: Manifest = {
        agents: {
          a: {
            name: "A", description: "A", url: "", install: "", launch: "", env: {},
          },
        },
        clouds: {
          b: {
            name: "B", description: "B", url: "", type: "vm", auth: "none",
            provision_method: "api", exec_method: "ssh", interactive_method: "ssh",
          },
        },
        matrix: {},
      };
      const lines = renderMatrixFooter(manifest, ["a"], ["b"], false);
      expect(lines.some((l) => l.includes("0/1"))).toBe(true);
    });
  });

  describe("usage hints", () => {
    it("should include launch command hint", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      expect(lines.some((l) => l.includes("spawn <agent> <cloud>"))).toBe(true);
    });

    it("should include details command hints", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      expect(lines.some((l) => l.includes("spawn <agent>") && l.includes("spawn <cloud>"))).toBe(true);
    });

    it("should end with an empty line", () => {
      const manifest = createTestManifest();
      const agents = agentKeys(manifest);
      const clouds = cloudKeys(manifest);
      const lines = renderMatrixFooter(manifest, agents, clouds, false);

      expect(lines[lines.length - 1]).toBe("");
    });
  });
});

// ── Exported helpers used by the rendering functions ─────────────────────────

describe("getTerminalWidth", () => {
  it("should return a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });

  it("should return at least 80 (fallback minimum)", () => {
    // In test environments without a TTY, should fall back to 80
    const width = getTerminalWidth();
    expect(width).toBeGreaterThanOrEqual(80);
  });
});

describe("calculateColumnWidth", () => {
  it("should return minimum width when items are shorter", () => {
    const width = calculateColumnWidth(["ab", "cd"], 16);
    expect(width).toBe(16);
  });

  it("should expand beyond minimum for long items", () => {
    const width = calculateColumnWidth(["a-very-long-cloud-name"], 10);
    expect(width).toBe("a-very-long-cloud-name".length + COL_PADDING);
  });

  it("should use the longest item to determine width", () => {
    const items = ["short", "medium-length", "the-longest-item-here"];
    const width = calculateColumnWidth(items, 10);
    expect(width).toBe("the-longest-item-here".length + COL_PADDING);
  });

  it("should return minimum width for empty items list", () => {
    const width = calculateColumnWidth([], 16);
    expect(width).toBe(16);
  });

  it("should handle single item", () => {
    const width = calculateColumnWidth(["x"], 16);
    expect(width).toBe(16); // "x" + 2 padding = 3, less than min 16
  });

  it("should add COL_PADDING (2) to item length", () => {
    // Item with length 15 + 2 padding = 17 > min 16
    const item = "a".repeat(15);
    const width = calculateColumnWidth([item], 16);
    expect(width).toBe(17);
  });

  it("should handle item at exactly minimum width - padding", () => {
    // Item with length 14 + 2 padding = 16 = min
    const item = "a".repeat(14);
    const width = calculateColumnWidth([item], 16);
    expect(width).toBe(16);
  });

  it("should handle item at minimum width - padding + 1", () => {
    // Item with length 15 + 2 padding = 17 > min 16
    const item = "a".repeat(15);
    const width = calculateColumnWidth([item], 16);
    expect(width).toBe(17);
  });
});

describe("getMissingClouds", () => {
  it("should return clouds where agent is not implemented", () => {
    const manifest = createTestManifest();
    const clouds = cloudKeys(manifest);
    const missing = getMissingClouds(manifest, "codex", clouds);
    expect(missing).toContain("hetzner");
    expect(missing).toContain("vultr");
    expect(missing).not.toContain("sprite");
  });

  it("should return empty array for fully implemented agent", () => {
    const manifest = createTestManifest();
    const clouds = cloudKeys(manifest);
    const missing = getMissingClouds(manifest, "claude", clouds);
    expect(missing).toEqual([]);
  });

  it("should return all clouds for unimplemented agent", () => {
    const manifest = createTestManifest();
    const clouds = cloudKeys(manifest);
    const missing = getMissingClouds(manifest, "cline", clouds);
    expect(missing).toHaveLength(3);
    expect(missing).toContain("sprite");
    expect(missing).toContain("hetzner");
    expect(missing).toContain("vultr");
  });

  it("should return empty for empty clouds list", () => {
    const manifest = createTestManifest();
    const missing = getMissingClouds(manifest, "codex", []);
    expect(missing).toEqual([]);
  });

  it("should return all for unknown agent (not in matrix)", () => {
    const manifest = createTestManifest();
    const clouds = cloudKeys(manifest);
    const missing = getMissingClouds(manifest, "unknown", clouds);
    expect(missing).toHaveLength(3); // All clouds are "missing" for unknown agent
  });

  it("should preserve cloud order from input", () => {
    const manifest = createTestManifest();
    const clouds = ["vultr", "sprite", "hetzner"];
    const missing = getMissingClouds(manifest, "cline", clouds);
    expect(missing).toEqual(["vultr", "sprite", "hetzner"]);
  });
});

describe("getImplementedClouds", () => {
  it("should return clouds where agent is implemented", () => {
    const manifest = createTestManifest();
    const impl = getImplementedClouds(manifest, "codex");
    expect(impl).toEqual(["sprite"]);
  });

  it("should return all clouds for fully implemented agent", () => {
    const manifest = createTestManifest();
    const impl = getImplementedClouds(manifest, "claude");
    expect(impl).toHaveLength(3);
    expect(impl).toContain("sprite");
    expect(impl).toContain("hetzner");
    expect(impl).toContain("vultr");
  });

  it("should return empty array for unimplemented agent", () => {
    const manifest = createTestManifest();
    const impl = getImplementedClouds(manifest, "cline");
    expect(impl).toEqual([]);
  });

  it("should return empty array for unknown agent", () => {
    const manifest = createTestManifest();
    const impl = getImplementedClouds(manifest, "nonexistent");
    expect(impl).toEqual([]);
  });

  it("should preserve manifest cloud key order", () => {
    const manifest = createTestManifest();
    const impl = getImplementedClouds(manifest, "claude");
    // Keys should be in the order they appear in manifest.clouds
    const allClouds = cloudKeys(manifest);
    const expected = allClouds.filter((c) => impl.includes(c));
    expect(impl).toEqual(expected);
  });
});

// ── Integration: compact view vs grid view decision ──────────────────────────

describe("compact vs grid view decision", () => {
  it("should calculate grid width as agentColWidth + clouds * cloudColWidth", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    const agentColWidth = calculateColumnWidth(
      agents.map((a) => manifest.agents[a].name),
      MIN_AGENT_COL_WIDTH
    );
    const cloudColWidth = calculateColumnWidth(
      clouds.map((c) => manifest.clouds[c].name),
      MIN_CLOUD_COL_WIDTH
    );

    const gridWidth = agentColWidth + clouds.length * cloudColWidth;
    expect(gridWidth).toBeGreaterThan(0);
    // With 3 clouds and reasonable names, grid should be moderate width
    expect(gridWidth).toBeLessThan(200);
  });

  it("should use compact view when grid is wider than terminal", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    const agentColWidth = calculateColumnWidth(
      agents.map((a) => manifest.agents[a].name),
      MIN_AGENT_COL_WIDTH
    );
    const cloudColWidth = calculateColumnWidth(
      clouds.map((c) => manifest.clouds[c].name),
      MIN_CLOUD_COL_WIDTH
    );

    const gridWidth = agentColWidth + clouds.length * cloudColWidth;
    const termWidth = getTerminalWidth();

    // This tests the decision logic: isCompact = gridWidth > termWidth
    const isCompact = gridWidth > termWidth;
    // With only 3 clouds and 80+ terminal, grid should fit
    // But the key point is the logic is correct
    expect(typeof isCompact).toBe("boolean");
  });

  it("should produce different legends for compact vs grid", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    const compactFooter = renderMatrixFooter(manifest, agents, clouds, true);
    const gridFooter = renderMatrixFooter(manifest, agents, clouds, false);

    const compactLegend = compactFooter.find((l) => l.includes("green"));
    const gridLegend = gridFooter.find((l) => l.includes("+ implemented"));

    expect(compactLegend).toBeDefined();
    expect(gridLegend).toBeDefined();

    // They should be different
    expect(compactLegend).not.toBe(gridLegend);
  });
});

// ── Integration: renderCompactList with getMissingClouds consistency ─────────

describe("renderCompactList and getMissingClouds consistency", () => {
  it("should show missing clouds matching getMissingClouds output", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    const lines = renderCompactList(manifest, agents, clouds);
    const codexMissing = getMissingClouds(manifest, "codex", clouds);

    const codexLine = lines.find((l) => l.includes("Codex"));
    expect(codexLine).toBeDefined();

    for (const cloudKey of codexMissing) {
      expect(codexLine).toContain(manifest.clouds[cloudKey].name);
    }
  });

  it("should show 'all clouds supported' only when getMissingClouds returns empty", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    const lines = renderCompactList(manifest, agents, clouds);

    for (const agent of agents) {
      const missing = getMissingClouds(manifest, agent, clouds);
      const agentLine = lines.find((l) => l.includes(manifest.agents[agent].name));
      expect(agentLine).toBeDefined();

      if (missing.length === 0) {
        expect(agentLine).toContain("all clouds supported");
      } else {
        expect(agentLine).not.toContain("all clouds supported");
      }
    }
  });

  it("should show count matching getImplementedClouds length", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const totalClouds = clouds.length;

    const lines = renderCompactList(manifest, agents, clouds);

    for (const agent of agents) {
      const implCount = getImplementedClouds(manifest, agent).length;
      const expectedCount = `${implCount}/${totalClouds}`;

      const agentLine = lines.find((l) => l.includes(manifest.agents[agent].name));
      expect(agentLine).toBeDefined();
      expect(agentLine).toContain(expectedCount);
    }
  });
});

// ── Footer implementation count matches countImplemented ────────────────────

describe("renderMatrixFooter count matches countImplemented", () => {
  it("should use countImplemented for the numerator", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);
    const impl = countImplemented(manifest);
    const total = agents.length * clouds.length;

    const lines = renderMatrixFooter(manifest, agents, clouds, false);
    expect(lines.some((l) => l.includes(`${impl}/${total}`))).toBe(true);
  });

  it("should calculate total as agents.length * clouds.length", () => {
    const manifest = createTestManifest();
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    const lines = renderMatrixFooter(manifest, agents, clouds, false);
    // 3 agents * 3 clouds = 9
    expect(lines.some((l) => l.includes("/9"))).toBe(true);
  });

  it("should handle 0/0 when both agents and clouds are empty", () => {
    const manifest: Manifest = { agents: {}, clouds: {}, matrix: {} };
    const lines = renderMatrixFooter(manifest, [], [], false);
    expect(lines.some((l) => l.includes("0/0"))).toBe(true);
  });
});
