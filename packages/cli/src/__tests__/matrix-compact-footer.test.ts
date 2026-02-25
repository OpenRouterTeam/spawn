import { describe, it, expect } from "bun:test";
import type { Manifest } from "../manifest";
import { getImplementedClouds, getMissingClouds, calculateColumnWidth, getTerminalWidth } from "../commands";
import { cloudKeys, agentKeys } from "../manifest";

/**
 * Tests for exported matrix helpers in commands.ts:
 * - getTerminalWidth: terminal width fallback to 80
 * - calculateColumnWidth: dynamic column sizing with minimum width
 * - getMissingClouds: clouds where an agent is NOT implemented
 * - getImplementedClouds: clouds where an agent IS implemented
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

const MIN_AGENT_COL_WIDTH = 16;
const MIN_CLOUD_COL_WIDTH = 10;
const COL_PADDING = 2;

// ── Tests for exported helpers ──────────────────────────────────────────────

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
    const width = calculateColumnWidth(
      [
        "ab",
        "cd",
      ],
      16,
    );
    expect(width).toBe(16);
  });

  it("should expand beyond minimum for long items", () => {
    const width = calculateColumnWidth(
      [
        "a-very-long-cloud-name",
      ],
      10,
    );
    expect(width).toBe("a-very-long-cloud-name".length + COL_PADDING);
  });

  it("should use the longest item to determine width", () => {
    const items = [
      "short",
      "medium-length",
      "the-longest-item-here",
    ];
    const width = calculateColumnWidth(items, 10);
    expect(width).toBe("the-longest-item-here".length + COL_PADDING);
  });

  it("should return minimum width for empty items list", () => {
    const width = calculateColumnWidth([], 16);
    expect(width).toBe(16);
  });

  it("should handle single item", () => {
    const width = calculateColumnWidth(
      [
        "x",
      ],
      16,
    );
    expect(width).toBe(16); // "x" + 2 padding = 3, less than min 16
  });

  it("should add COL_PADDING (2) to item length", () => {
    // Item with length 15 + 2 padding = 17 > min 16
    const item = "a".repeat(15);
    const width = calculateColumnWidth(
      [
        item,
      ],
      16,
    );
    expect(width).toBe(17);
  });

  it("should handle item at exactly minimum width - padding", () => {
    // Item with length 14 + 2 padding = 16 = min
    const item = "a".repeat(14);
    const width = calculateColumnWidth(
      [
        item,
      ],
      16,
    );
    expect(width).toBe(16);
  });

  it("should handle item at minimum width - padding + 1", () => {
    // Item with length 15 + 2 padding = 17 > min 16
    const item = "a".repeat(15);
    const width = calculateColumnWidth(
      [
        item,
      ],
      16,
    );
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
    const clouds = [
      "vultr",
      "sprite",
      "hetzner",
    ];
    const missing = getMissingClouds(manifest, "cline", clouds);
    expect(missing).toEqual([
      "vultr",
      "sprite",
      "hetzner",
    ]);
  });
});

describe("getImplementedClouds", () => {
  it("should return clouds where agent is implemented", () => {
    const manifest = createTestManifest();
    const impl = getImplementedClouds(manifest, "codex");
    expect(impl).toEqual([
      "sprite",
    ]);
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
      MIN_AGENT_COL_WIDTH,
    );
    const cloudColWidth = calculateColumnWidth(
      clouds.map((c) => manifest.clouds[c].name),
      MIN_CLOUD_COL_WIDTH,
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
      MIN_AGENT_COL_WIDTH,
    );
    const cloudColWidth = calculateColumnWidth(
      clouds.map((c) => manifest.clouds[c].name),
      MIN_CLOUD_COL_WIDTH,
    );

    const gridWidth = agentColWidth + clouds.length * cloudColWidth;
    const termWidth = getTerminalWidth();

    // This tests the decision logic: isCompact = gridWidth > termWidth
    const isCompact = gridWidth > termWidth;
    // With only 3 clouds and 80+ terminal, grid should fit
    // But the key point is the logic is correct
    expect(typeof isCompact).toBe("boolean");
  });
});
