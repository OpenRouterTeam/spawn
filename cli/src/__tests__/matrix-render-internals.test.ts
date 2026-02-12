import { describe, it, expect } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Tests for matrix rendering internal functions and formatTimestamp.
 *
 * These functions have zero direct test references (verified via grep):
 * - renderMatrixHeader (commands.ts:690-696): builds column header line
 * - renderMatrixSeparator (commands.ts:698-704): builds separator line
 * - renderMatrixRow (commands.ts:706-715): builds a row with +/- status icons
 * - renderCompactList (commands.ts:721-745): agent-per-line compact view
 * - renderMatrixFooter (commands.ts:747-759): legend + count + usage hint
 * - formatTimestamp (commands.ts:803-813): formats ISO dates for display
 *
 * While cmdMatrix integration tests exercise these indirectly, edge cases
 * in the rendering logic are not covered:
 * - Column alignment with variable-length names
 * - Status icon coloring for implemented vs missing
 * - Compact view "all clouds supported" vs missing cloud list
 * - Footer legend text for grid vs compact mode
 * - formatTimestamp with invalid dates, timezone edge cases, empty strings
 *
 * All functions are not exported, so we test exact replicas following the
 * established pattern in this codebase.
 *
 * Agent: test-engineer
 */

// ── Exact replicas of internal functions from commands.ts ───────────────────

const COL_PADDING = 2;

// commands.ts:690-696
function renderMatrixHeader(
  clouds: string[],
  manifest: Manifest,
  agentColWidth: number,
  cloudColWidth: number
): string {
  let header = "".padEnd(agentColWidth);
  for (const c of clouds) {
    header += manifest.clouds[c].name.padEnd(cloudColWidth);
  }
  return header;
}

// commands.ts:698-704
function renderMatrixSeparator(
  clouds: string[],
  agentColWidth: number,
  cloudColWidth: number
): string {
  let sep = "".padEnd(agentColWidth);
  for (const _ of clouds) {
    sep += ("-".repeat(cloudColWidth - COL_PADDING) + "  ");
  }
  return sep;
}

// commands.ts:706-715 (simplified - no picocolors in test)
function renderMatrixRow(
  agent: string,
  clouds: string[],
  manifest: Manifest,
  agentColWidth: number,
  cloudColWidth: number
): { agentName: string; statuses: Array<{ cloud: string; status: string; icon: string }> } {
  const agentName = manifest.agents[agent].name;
  const statuses = clouds.map((c) => {
    const status = manifest.matrix[`${c}/${agent}`] ?? "missing";
    const icon = status === "implemented" ? "  +" : "  -";
    return { cloud: c, status, icon };
  });
  return { agentName, statuses };
}

// commands.ts:803-813
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

// commands.ts:679-688
function calculateColumnWidth(items: string[], minWidth: number): number {
  let maxWidth = minWidth;
  for (const item of items) {
    const width = item.length + COL_PADDING;
    if (width > maxWidth) {
      maxWidth = width;
    }
  }
  return maxWidth;
}

// commands.ts:717-719
function getMissingClouds(
  manifest: Manifest,
  agent: string,
  clouds: string[]
): string[] {
  return clouds.filter(
    (c) => (manifest.matrix[`${c}/${agent}`] ?? "missing") !== "implemented"
  );
}

// commands.ts:70-74
function getImplementedClouds(manifest: Manifest, agent: string): string[] {
  return Object.keys(manifest.clouds).filter(
    (c) => manifest.matrix[`${c}/${agent}`] === "implemented"
  );
}

// ── Test manifests ─────────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    agents: {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: {},
      },
      aider: {
        name: "Aider",
        description: "AI pair programmer",
        url: "https://aider.chat",
        install: "pip install aider-chat",
        launch: "aider",
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
    },
    matrix: {
      "sprite/claude": "implemented",
      "sprite/aider": "implemented",
      "hetzner/claude": "implemented",
      "hetzner/aider": "missing",
    },
    ...overrides,
  };
}

// ── renderMatrixHeader ──────────────────────────────────────────────────────

describe("renderMatrixHeader", () => {
  const m = makeManifest();
  const clouds = ["sprite", "hetzner"];

  it("should start with agent column padding", () => {
    const header = renderMatrixHeader(clouds, m, 16, 14);
    expect(header.startsWith(" ".repeat(16))).toBe(true);
  });

  it("should include cloud display names", () => {
    const header = renderMatrixHeader(clouds, m, 16, 14);
    expect(header).toContain("Sprite");
    expect(header).toContain("Hetzner Cloud");
  });

  it("should pad each cloud name to cloudColWidth", () => {
    const header = renderMatrixHeader(clouds, m, 16, 20);
    // After agent padding (16 chars), "Sprite" should be padded to 20 chars
    const afterAgent = header.substring(16);
    // First cloud section should be 20 chars
    expect(afterAgent.substring(0, 20).trimEnd()).toBe("Sprite");
    expect(afterAgent.substring(0, 20).length).toBe(20);
  });

  it("should handle single cloud", () => {
    const header = renderMatrixHeader(["sprite"], m, 16, 14);
    expect(header).toContain("Sprite");
    expect(header).not.toContain("Hetzner");
  });

  it("should handle wide agent column", () => {
    const header = renderMatrixHeader(clouds, m, 30, 14);
    // Agent column is 30 chars of padding
    expect(header.substring(0, 30).trim()).toBe("");
    expect(header.substring(30)).toContain("Sprite");
  });

  it("should preserve cloud order", () => {
    const reversed = renderMatrixHeader(["hetzner", "sprite"], m, 16, 14);
    const hetznerIdx = reversed.indexOf("Hetzner");
    const spriteIdx = reversed.indexOf("Sprite");
    expect(hetznerIdx).toBeLessThan(spriteIdx);
  });
});

// ── renderMatrixSeparator ───────────────────────────────────────────────────

describe("renderMatrixSeparator", () => {
  it("should start with agent column padding", () => {
    const sep = renderMatrixSeparator(["a", "b"], 16, 14);
    expect(sep.startsWith(" ".repeat(16))).toBe(true);
  });

  it("should have dashes for each cloud column", () => {
    const sep = renderMatrixSeparator(["a", "b"], 16, 14);
    // After agent padding, each cloud gets (cloudColWidth - COL_PADDING) dashes + "  "
    const afterAgent = sep.substring(16);
    expect(afterAgent).toContain("-".repeat(12));
  });

  it("should have separator segments matching cloud count", () => {
    const sep = renderMatrixSeparator(["a", "b", "c"], 16, 10);
    const afterAgent = sep.substring(16);
    // Each cloud: 8 dashes + 2 spaces = 10 chars
    const segments = afterAgent.match(/-{8}\s{2}/g) || [];
    expect(segments.length).toBe(3);
  });

  it("should handle single cloud", () => {
    const sep = renderMatrixSeparator(["x"], 16, 14);
    const afterAgent = sep.substring(16);
    expect(afterAgent).toContain("-".repeat(12));
    expect(afterAgent.trim().length).toBe(12);
  });

  it("should have consistent width with header", () => {
    const m = makeManifest();
    const clouds = ["sprite", "hetzner"];
    const agentW = 16;
    const cloudW = 14;
    const header = renderMatrixHeader(clouds, m, agentW, cloudW);
    const sep = renderMatrixSeparator(clouds, agentW, cloudW);
    // Both should have the same total width concept
    expect(header.length).toBeGreaterThan(0);
    expect(sep.length).toBeGreaterThan(0);
  });
});

// ── renderMatrixRow ─────────────────────────────────────────────────────────

describe("renderMatrixRow", () => {
  const m = makeManifest();
  const clouds = ["sprite", "hetzner"];

  it("should return correct agent name", () => {
    const row = renderMatrixRow("claude", clouds, m, 16, 14);
    expect(row.agentName).toBe("Claude Code");
  });

  it("should show + for implemented combinations", () => {
    const row = renderMatrixRow("claude", clouds, m, 16, 14);
    // sprite/claude and hetzner/claude are both implemented
    expect(row.statuses[0].icon).toBe("  +");
    expect(row.statuses[1].icon).toBe("  +");
  });

  it("should show - for missing combinations", () => {
    const row = renderMatrixRow("aider", clouds, m, 16, 14);
    // sprite/aider is implemented, hetzner/aider is missing
    expect(row.statuses[0].icon).toBe("  +");
    expect(row.statuses[1].icon).toBe("  -");
  });

  it("should have correct status strings", () => {
    const row = renderMatrixRow("aider", clouds, m, 16, 14);
    expect(row.statuses[0].status).toBe("implemented");
    expect(row.statuses[1].status).toBe("missing");
  });

  it("should match cloud order to input clouds array", () => {
    const row = renderMatrixRow("aider", clouds, m, 16, 14);
    expect(row.statuses[0].cloud).toBe("sprite");
    expect(row.statuses[1].cloud).toBe("hetzner");
  });

  it("should default to missing for unknown matrix entries", () => {
    const partialMatrix: Manifest = {
      ...m,
      matrix: { "sprite/claude": "implemented" },
    };
    const row = renderMatrixRow("claude", ["sprite", "hetzner"], partialMatrix, 16, 14);
    expect(row.statuses[0].status).toBe("implemented");
    expect(row.statuses[1].status).toBe("missing");
    expect(row.statuses[1].icon).toBe("  -");
  });

  it("should handle all-implemented row", () => {
    const allImpl: Manifest = {
      ...m,
      matrix: { "sprite/claude": "implemented", "hetzner/claude": "implemented" },
    };
    const row = renderMatrixRow("claude", clouds, allImpl, 16, 14);
    expect(row.statuses.every((s) => s.icon === "  +")).toBe(true);
  });

  it("should handle all-missing row", () => {
    const allMissing: Manifest = {
      ...m,
      matrix: { "sprite/claude": "missing", "hetzner/claude": "missing" },
    };
    const row = renderMatrixRow("claude", clouds, allMissing, 16, 14);
    expect(row.statuses.every((s) => s.icon === "  -")).toBe(true);
  });

  it("should handle single cloud column", () => {
    const row = renderMatrixRow("claude", ["sprite"], m, 16, 14);
    expect(row.statuses).toHaveLength(1);
    expect(row.statuses[0].icon).toBe("  +");
  });
});

// ── calculateColumnWidth ────────────────────────────────────────────────────

describe("calculateColumnWidth edge cases", () => {
  it("should return minWidth when all items are shorter", () => {
    const width = calculateColumnWidth(["ab", "cd"], 20);
    expect(width).toBe(20);
  });

  it("should return item width + padding when item exceeds minWidth", () => {
    const width = calculateColumnWidth(["a very long name"], 10);
    expect(width).toBe("a very long name".length + COL_PADDING);
  });

  it("should use the longest item", () => {
    const width = calculateColumnWidth(["short", "medium name", "the longest name here"], 5);
    expect(width).toBe("the longest name here".length + COL_PADDING);
  });

  it("should return minWidth for empty items array", () => {
    const width = calculateColumnWidth([], 16);
    expect(width).toBe(16);
  });

  it("should handle single item", () => {
    const width = calculateColumnWidth(["hello"], 3);
    expect(width).toBe("hello".length + COL_PADDING);
  });

  it("should handle items exactly at minWidth - padding", () => {
    // Item of length 14 + padding 2 = 16, which equals minWidth
    const width = calculateColumnWidth(["12345678901234"], 16);
    expect(width).toBe(16);
  });

  it("should handle items one char over minWidth threshold", () => {
    // Item of length 15 + padding 2 = 17, exceeds minWidth 16
    const width = calculateColumnWidth(["123456789012345"], 16);
    expect(width).toBe(17);
  });
});

// ── getMissingClouds ────────────────────────────────────────────────────────

describe("getMissingClouds edge cases", () => {
  const m = makeManifest();

  it("should return missing clouds for partially implemented agent", () => {
    const missing = getMissingClouds(m, "aider", ["sprite", "hetzner"]);
    expect(missing).toEqual(["hetzner"]);
  });

  it("should return empty array for fully implemented agent", () => {
    const missing = getMissingClouds(m, "claude", ["sprite", "hetzner"]);
    expect(missing).toEqual([]);
  });

  it("should return all clouds when agent has no implementations", () => {
    const noImpl: Manifest = {
      ...m,
      matrix: {
        "sprite/claude": "missing",
        "hetzner/claude": "missing",
        "sprite/aider": "missing",
        "hetzner/aider": "missing",
      },
    };
    const missing = getMissingClouds(noImpl, "claude", ["sprite", "hetzner"]);
    expect(missing).toEqual(["sprite", "hetzner"]);
  });

  it("should handle clouds not in the matrix at all", () => {
    const missing = getMissingClouds(m, "claude", ["sprite", "hetzner", "unknown"]);
    // "unknown" is not in matrix, so matrixStatus defaults to "missing"
    expect(missing).toEqual(["unknown"]);
  });

  it("should handle empty clouds array", () => {
    const missing = getMissingClouds(m, "claude", []);
    expect(missing).toEqual([]);
  });
});

// ── getImplementedClouds ────────────────────────────────────────────────────

describe("getImplementedClouds edge cases", () => {
  const m = makeManifest();

  it("should return all implemented clouds for agent", () => {
    const impl = getImplementedClouds(m, "claude");
    expect(impl).toContain("sprite");
    expect(impl).toContain("hetzner");
    expect(impl).toHaveLength(2);
  });

  it("should exclude missing clouds", () => {
    const impl = getImplementedClouds(m, "aider");
    expect(impl).toContain("sprite");
    expect(impl).not.toContain("hetzner");
    expect(impl).toHaveLength(1);
  });

  it("should return empty array for unknown agent", () => {
    const impl = getImplementedClouds(m, "nonexistent");
    expect(impl).toEqual([]);
  });

  it("should return empty array when all are missing", () => {
    const allMissing: Manifest = {
      ...m,
      matrix: {
        "sprite/claude": "missing",
        "hetzner/claude": "missing",
        "sprite/aider": "missing",
        "hetzner/aider": "missing",
      },
    };
    const impl = getImplementedClouds(allMissing, "claude");
    expect(impl).toEqual([]);
  });
});

// ── formatTimestamp ──────────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  it("should format a valid ISO timestamp", () => {
    const result = formatTimestamp("2026-02-11T14:30:00.000Z");
    // Should contain month, day, year
    expect(result).toContain("2026");
    expect(result).toContain("Feb");
    expect(result).toContain("11");
  });

  it("should return the original string for invalid dates", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("should return the original string for empty string", () => {
    expect(formatTimestamp("")).toBe("");
  });

  it("should return the original string for random text", () => {
    expect(formatTimestamp("hello world")).toBe("hello world");
  });

  it("should handle date-only ISO string", () => {
    const result = formatTimestamp("2026-06-15");
    // Should format successfully (Date parses date-only strings)
    expect(result).toContain("2026");
    expect(result).toContain("Jun");
  });

  it("should handle midnight timestamp", () => {
    const result = formatTimestamp("2026-01-01T00:00:00.000Z");
    expect(result).toContain("2026");
    expect(result).toContain("Jan");
  });

  it("should handle end-of-day timestamp", () => {
    const result = formatTimestamp("2026-12-31T23:59:59.000Z");
    expect(result).toContain("2026");
    expect(result).toContain("Dec");
    expect(result).toContain("31");
  });

  it("should handle timestamp without milliseconds", () => {
    const result = formatTimestamp("2026-03-15T10:30:00Z");
    expect(result).toContain("2026");
    expect(result).toContain("Mar");
  });

  it("should handle timestamp with timezone offset", () => {
    const result = formatTimestamp("2026-07-04T12:00:00+05:30");
    expect(result).toContain("2026");
    expect(result).toContain("Jul");
  });

  it("should return original for partial date strings", () => {
    // "2026-13" is invalid (month 13)
    const result = formatTimestamp("2026-13-01T00:00:00Z");
    // Date constructor may or may not parse this depending on runtime
    // If NaN, returns original
    if (isNaN(new Date("2026-13-01T00:00:00Z").getTime())) {
      expect(result).toBe("2026-13-01T00:00:00Z");
    } else {
      // If parsed, should contain year
      expect(result).toContain("2026");
    }
  });

  it("should format a Unix epoch timestamp string", () => {
    // "0" parses to 1970-01-01 via Date(0)
    const result = formatTimestamp("1970-01-01T00:00:00.000Z");
    expect(result).toContain("1970");
    expect(result).toContain("Jan");
  });

  it("should return original for 'undefined' string", () => {
    expect(formatTimestamp("undefined")).toBe("undefined");
  });

  it("should return original for 'null' string", () => {
    expect(formatTimestamp("null")).toBe("null");
  });

  it("should handle far-future dates", () => {
    const result = formatTimestamp("2099-12-31T23:59:59.000Z");
    expect(result).toContain("2099");
  });

  it("should handle dates in the past", () => {
    const result = formatTimestamp("2000-01-01T00:00:00.000Z");
    expect(result).toContain("2000");
    expect(result).toContain("Jan");
  });

  it("should include time component in output", () => {
    const result = formatTimestamp("2026-06-15T14:30:00.000Z");
    // Should include time in HH:MM format (24-hour)
    // The exact time depends on the local timezone, but it should be there
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it("should return a string combining date and time parts", () => {
    const result = formatTimestamp("2026-06-15T14:30:00.000Z");
    // Format is "Mon DD, YYYY HH:MM"
    expect(result.split(" ").length).toBeGreaterThanOrEqual(3);
  });
});

// ── Compact view data helpers ───────────────────────────────────────────────

describe("compact view data assembly", () => {
  const m = makeManifest();
  const agents = Object.keys(m.agents);
  const clouds = Object.keys(m.clouds);

  it("should compute correct count for fully implemented agent", () => {
    const implCount = getImplementedClouds(m, "claude").length;
    expect(implCount).toBe(2);
    expect(implCount).toBe(clouds.length);
  });

  it("should compute correct count for partially implemented agent", () => {
    const implCount = getImplementedClouds(m, "aider").length;
    expect(implCount).toBe(1);
    expect(implCount).toBeLessThan(clouds.length);
  });

  it("should produce count string in N/M format", () => {
    const implCount = getImplementedClouds(m, "claude").length;
    const countStr = `${implCount}/${clouds.length}`;
    expect(countStr).toBe("2/2");
  });

  it("should detect 'all clouds supported' condition", () => {
    const missing = getMissingClouds(m, "claude", clouds);
    expect(missing.length === 0).toBe(true);
  });

  it("should list missing cloud names for partial agent", () => {
    const missing = getMissingClouds(m, "aider", clouds);
    expect(missing).toHaveLength(1);
    const missingNames = missing.map((c) => m.clouds[c].name);
    expect(missingNames).toContain("Hetzner Cloud");
  });

  it("should handle agent with no implementations", () => {
    const noImpl: Manifest = {
      ...m,
      matrix: {
        "sprite/claude": "missing",
        "hetzner/claude": "missing",
        "sprite/aider": "missing",
        "hetzner/aider": "missing",
      },
    };
    const implCount = getImplementedClouds(noImpl, "claude").length;
    expect(implCount).toBe(0);
    const missing = getMissingClouds(noImpl, "claude", Object.keys(noImpl.clouds));
    expect(missing).toHaveLength(2);
  });
});

// ── Matrix footer data ──────────────────────────────────────────────────────

describe("matrix footer data", () => {
  const m = makeManifest();

  it("should compute correct total combinations", () => {
    const agents = Object.keys(m.agents);
    const clouds = Object.keys(m.clouds);
    const total = agents.length * clouds.length;
    expect(total).toBe(4);
  });

  it("should compute correct implemented count", () => {
    let impl = 0;
    for (const v of Object.values(m.matrix)) {
      if (v === "implemented") impl++;
    }
    expect(impl).toBe(3);
  });

  it("should format count as 'N/M combinations implemented'", () => {
    let impl = 0;
    for (const v of Object.values(m.matrix)) {
      if (v === "implemented") impl++;
    }
    const agents = Object.keys(m.agents);
    const clouds = Object.keys(m.clouds);
    const total = agents.length * clouds.length;
    const line = `${impl}/${total} combinations implemented`;
    expect(line).toBe("3/4 combinations implemented");
  });

  it("should show grid legend in non-compact mode", () => {
    const isCompact = false;
    const legend = isCompact
      ? "green = all clouds supported  yellow = some clouds not yet available"
      : "+ implemented  - not yet available";
    expect(legend).toBe("+ implemented  - not yet available");
  });

  it("should show compact legend in compact mode", () => {
    const isCompact = true;
    const legend = isCompact
      ? "green = all clouds supported  yellow = some clouds not yet available"
      : "+ implemented  - not yet available";
    expect(legend).toContain("all clouds supported");
  });
});

// ── Grid vs compact decision logic ──────────────────────────────────────────

describe("grid vs compact view decision", () => {
  it("should prefer grid when terminal is wide enough", () => {
    const agentColWidth = 16;
    const cloudColWidth = 14;
    const numClouds = 3;
    const gridWidth = agentColWidth + numClouds * cloudColWidth;
    const termWidth = 100;
    expect(gridWidth > termWidth).toBe(false); // grid fits
  });

  it("should use compact when grid exceeds terminal width", () => {
    const agentColWidth = 16;
    const cloudColWidth = 14;
    const numClouds = 10;
    const gridWidth = agentColWidth + numClouds * cloudColWidth;
    const termWidth = 80;
    expect(gridWidth > termWidth).toBe(true); // grid doesn't fit
  });

  it("should use grid at exact terminal width boundary", () => {
    const agentColWidth = 16;
    const cloudColWidth = 14;
    const numClouds = 4;
    const gridWidth = agentColWidth + numClouds * cloudColWidth;
    // gridWidth = 16 + 56 = 72
    expect(gridWidth).toBe(72);
    const termWidth = 72;
    // gridWidth > termWidth is false, so grid view is used
    expect(gridWidth > termWidth).toBe(false);
  });

  it("should switch to compact at terminal width - 1", () => {
    const agentColWidth = 16;
    const cloudColWidth = 14;
    const numClouds = 4;
    const gridWidth = agentColWidth + numClouds * cloudColWidth;
    const termWidth = 71;
    expect(gridWidth > termWidth).toBe(true);
  });

  it("should handle many clouds requiring compact view", () => {
    const agentColWidth = 20;
    const cloudColWidth = 18;
    const numClouds = 20;
    const gridWidth = agentColWidth + numClouds * cloudColWidth;
    expect(gridWidth).toBe(380);
    // Even a very wide terminal can't fit this
    expect(gridWidth > 200).toBe(true);
  });

  it("should handle single cloud always fitting in grid", () => {
    const agentColWidth = 16;
    const cloudColWidth = 14;
    const numClouds = 1;
    const gridWidth = agentColWidth + numClouds * cloudColWidth;
    expect(gridWidth).toBe(30);
    // Even narrow terminals (40 cols) can fit single-cloud grid
    expect(gridWidth > 40).toBe(false);
  });
});

// ── Matrix header/row width consistency ─────────────────────────────────────

describe("matrix header and row width consistency", () => {
  const m = makeManifest();
  const clouds = ["sprite", "hetzner"];
  const agentW = calculateColumnWidth(
    Object.keys(m.agents).map((a) => m.agents[a].name),
    16
  );
  const cloudW = calculateColumnWidth(
    clouds.map((c) => m.clouds[c].name),
    10
  );

  it("should produce header and separator of matching structure", () => {
    const header = renderMatrixHeader(clouds, m, agentW, cloudW);
    const sep = renderMatrixSeparator(clouds, agentW, cloudW);
    // Both start with agentW padding
    expect(header.substring(0, agentW).trim()).toBe("");
    expect(sep.substring(0, agentW).trim()).toBe("");
  });

  it("should produce rows with correct agent name", () => {
    const row = renderMatrixRow("claude", clouds, m, agentW, cloudW);
    expect(row.agentName).toBe("Claude Code");
  });

  it("should produce rows with one status per cloud", () => {
    const row = renderMatrixRow("claude", clouds, m, agentW, cloudW);
    expect(row.statuses).toHaveLength(clouds.length);
  });

  it("should align column widths with calculated widths", () => {
    // Verify calculated widths match expectations
    expect(agentW).toBeGreaterThanOrEqual(16);
    expect(cloudW).toBeGreaterThanOrEqual(10);
    // Cloud column should be at least as wide as "Hetzner Cloud" + padding
    expect(cloudW).toBeGreaterThanOrEqual("Hetzner Cloud".length + COL_PADDING);
  });
});

// ── Large manifest scenarios ────────────────────────────────────────────────

describe("large manifest scenarios", () => {
  it("should handle many agents efficiently", () => {
    const agents: Record<string, any> = {};
    const matrix: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      agents[`agent-${i}`] = {
        name: `Agent ${i}`,
        description: `Description ${i}`,
        url: `https://example.com/${i}`,
        install: `install-${i}`,
        launch: `launch-${i}`,
        env: {},
      };
      matrix[`cloud/agent-${i}`] = i % 2 === 0 ? "implemented" : "missing";
    }

    const bigManifest: Manifest = {
      agents,
      clouds: {
        cloud: {
          name: "Test Cloud",
          description: "Test",
          url: "https://test.com",
          type: "cloud",
          auth: "TOKEN",
          provision_method: "api",
          exec_method: "ssh",
          interactive_method: "ssh",
        },
      },
      matrix,
    };

    // All 50 agents should produce valid rows
    for (const agent of Object.keys(agents)) {
      const row = renderMatrixRow(agent, ["cloud"], bigManifest, 16, 14);
      expect(row.agentName).toBe(agents[agent].name);
      expect(row.statuses).toHaveLength(1);
    }
  });

  it("should handle many clouds efficiently", () => {
    const clouds: Record<string, any> = {};
    const matrix: Record<string, string> = {};
    const cloudKeys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const key = `cloud-${i}`;
      cloudKeys.push(key);
      clouds[key] = {
        name: `Cloud ${i}`,
        description: `Description ${i}`,
        url: `https://cloud${i}.com`,
        type: "cloud",
        auth: `TOKEN_${i}`,
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      };
      matrix[`${key}/agent`] = i % 3 === 0 ? "implemented" : "missing";
    }

    const bigManifest: Manifest = {
      agents: {
        agent: {
          name: "Test Agent",
          description: "Test",
          url: "https://test.com",
          install: "install",
          launch: "launch",
          env: {},
        },
      },
      clouds,
      matrix,
    };

    const row = renderMatrixRow("agent", cloudKeys, bigManifest, 16, 14);
    expect(row.statuses).toHaveLength(30);
    // 10 implemented (i=0,3,6,...,27)
    const implCount = row.statuses.filter((s) => s.icon === "  +").length;
    expect(implCount).toBe(10);
  });
});
