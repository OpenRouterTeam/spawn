import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";

/**
 * Tests for showListFooter prompt escaping and renderListTable special-character
 * handling in commands.ts.
 *
 * showListFooter (commands.ts:864-883) builds a "Rerun last:" hint that includes
 * the prompt text in a shell-safe format. The `safePrompt` variable escapes
 * double quotes with backslash to prevent shell injection in the suggested command.
 *
 * renderListTable (commands.ts:893-913) displays prompt previews inline with
 * history rows, truncating at 40 characters.
 *
 * These tests cover:
 * - Double-quote escaping in footer rerun hint (security-adjacent)
 * - Backslash handling in prompts
 * - Unicode characters in prompts
 * - Newlines/tabs in prompts
 * - Empty-ish prompts (whitespace-only)
 * - Prompt at exactly 30 chars (footer boundary) and 40 chars (row boundary)
 * - getMissingClouds helper logic
 * - renderMatrixFooter singular/plural forms
 * - getTerminalWidth fallback
 * - calculateColumnWidth edge cases
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
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
    warn: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import after mock setup
const {
  cmdList,
  getImplementedClouds,
  getMissingClouds,
  getTerminalWidth,
  calculateColumnWidth,
  getImplementedAgents,
} = await import("../commands.js");

// ── showListFooter prompt escaping ──────────────────────────────────────────

describe("showListFooter prompt escaping", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    originalEnv = { ...process.env };

    testDir = join(tmpdir(), `spawn-footer-esc-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;

    // Setup manifest
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  function getRerunLine(): string | undefined {
    const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
    return lines.find((l: string) => l.includes("Rerun last"));
  }

  it("should escape double quotes in prompt for shell-safe rerun hint", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: 'Fix "all" bugs' },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    // Double quotes should be escaped as \"
    expect(rerunLine!).toContain('\\"all\\"');
    // Should not have unescaped double quotes inside the prompt
    expect(rerunLine!).not.toMatch(/--prompt "Fix "all" bugs"/);
  });

  it("should escape multiple double quotes in prompt", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: '"hello" "world"' },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).toContain('\\"hello\\"');
    expect(rerunLine!).toContain('\\"world\\"');
  });

  it("should handle prompt with no double quotes (no escaping needed)", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Fix all bugs" },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).toContain('--prompt "Fix all bugs"');
  });

  it("should truncate prompt at 30 chars before escaping in footer", async () => {
    // 35 chars with a double quote at position 32 (after truncation)
    const prompt = "A".repeat(28) + '"X' + "B".repeat(10);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    // Truncated to 30 chars + "..."
    expect(rerunLine!).toContain("...");
  });

  it("should handle prompt with backslashes", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Fix path\\to\\file" },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    // Backslashes should appear in the prompt
    expect(rerunLine!).toContain("path\\to\\file");
  });

  it("should handle prompt with special shell characters", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Fix $HOME issue" },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).toContain("$HOME");
  });

  it("should handle prompt with unicode characters", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Fix the bug \u2192 deploy" },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).toContain("\u2192");
  });

  it("should not show --prompt in rerun when latest record has no prompt", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).not.toContain("--prompt");
    expect(rerunLine!).toContain("spawn claude sprite");
  });

  it("should show rerun hint for most recent (reversed) record", async () => {
    writeHistory([
      { agent: "aider", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-02T10:00:00.000Z", prompt: "Latest task" },
    ]);

    await cmdList();

    const rerunLine = getRerunLine();
    expect(rerunLine).toBeDefined();
    // Most recent after reverse is "claude" (timestamp 01-02)
    expect(rerunLine!).toContain("spawn claude sprite");
    expect(rerunLine!).toContain("Latest task");
  });
});

// ── renderListTable prompt with special characters ──────────────────────────

describe("renderListTable special character prompts", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    originalEnv = { ...process.env };

    testDir = join(tmpdir(), `spawn-table-special-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;

    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  it("should display prompt with double quotes in table row", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: 'Fix "the" issue' },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain('"the"');
  });

  it("should truncate prompt at 40 chars in table row with ellipsis", async () => {
    const longPrompt = "D".repeat(45);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: longPrompt },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("D".repeat(40) + "...");
  });

  it("should show exactly 40-char prompt in row without truncation", async () => {
    const exact40 = "E".repeat(40);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: exact40 },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("E".repeat(40));
    expect(output).not.toContain("E".repeat(40) + "...");
  });

  it("should handle prompt with newline characters in table row", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Line1\nLine2" },
    ]);

    await cmdList();
    // Should display without crashing (newline handling is up to console)
    const output = getOutput();
    expect(output).toContain("Line1");
  });

  it("should handle prompt with tab characters", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Col1\tCol2" },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("Col1");
  });
});

// ── getMissingClouds helper ─────────────────────────────────────────────────

describe("getMissingClouds", () => {
  it("should return clouds not implemented for agent", () => {
    const missing = getMissingClouds(mockManifest, "aider", ["sprite", "hetzner"]);
    // sprite/aider is implemented, hetzner/aider is missing
    expect(missing).toContain("hetzner");
    expect(missing).not.toContain("sprite");
  });

  it("should return empty array when agent is implemented on all clouds", () => {
    const missing = getMissingClouds(mockManifest, "claude", ["sprite", "hetzner"]);
    // Both sprite/claude and hetzner/claude are implemented
    expect(missing).toEqual([]);
  });

  it("should return all clouds when agent is not implemented on any", () => {
    const allMissingManifest: Manifest = {
      ...mockManifest,
      matrix: {
        "sprite/claude": "missing",
        "sprite/aider": "missing",
        "hetzner/claude": "missing",
        "hetzner/aider": "missing",
      },
    };
    const missing = getMissingClouds(allMissingManifest, "claude", ["sprite", "hetzner"]);
    expect(missing).toEqual(["sprite", "hetzner"]);
  });

  it("should handle empty cloud list", () => {
    const missing = getMissingClouds(mockManifest, "claude", []);
    expect(missing).toEqual([]);
  });

  it("should handle agent not in matrix at all", () => {
    const missing = getMissingClouds(mockManifest, "nonexistent", ["sprite", "hetzner"]);
    // No matrix entries for nonexistent agent, so all are missing
    expect(missing).toEqual(["sprite", "hetzner"]);
  });
});

// ── getImplementedClouds ────────────────────────────────────────────────────

describe("getImplementedClouds", () => {
  it("should return implemented clouds for claude", () => {
    const clouds = getImplementedClouds(mockManifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
    expect(clouds).toHaveLength(2);
  });

  it("should return only implemented clouds for aider", () => {
    const clouds = getImplementedClouds(mockManifest, "aider");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
    expect(clouds).toHaveLength(1);
  });

  it("should return empty array for nonexistent agent", () => {
    const clouds = getImplementedClouds(mockManifest, "nonexistent");
    expect(clouds).toEqual([]);
  });

  it("should return empty array when all entries are missing", () => {
    const noImplManifest: Manifest = {
      ...mockManifest,
      matrix: {
        "sprite/claude": "missing",
        "sprite/aider": "missing",
        "hetzner/claude": "missing",
        "hetzner/aider": "missing",
      },
    };
    const clouds = getImplementedClouds(noImplManifest, "claude");
    expect(clouds).toEqual([]);
  });
});

// ── getImplementedAgents ────────────────────────────────────────────────────

describe("getImplementedAgents", () => {
  it("should return implemented agents for sprite", () => {
    const agents = getImplementedAgents(mockManifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("aider");
    expect(agents).toHaveLength(2);
  });

  it("should return only implemented agents for hetzner", () => {
    const agents = getImplementedAgents(mockManifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).not.toContain("aider");
    expect(agents).toHaveLength(1);
  });

  it("should return empty array for nonexistent cloud", () => {
    const agents = getImplementedAgents(mockManifest, "nonexistent");
    expect(agents).toEqual([]);
  });
});

// ── calculateColumnWidth ────────────────────────────────────────────────────

describe("calculateColumnWidth", () => {
  it("should return minimum width when all items are shorter", () => {
    const width = calculateColumnWidth(["a", "bb"], 20);
    expect(width).toBe(20);
  });

  it("should return item width + padding when item exceeds minimum", () => {
    // "Hetzner Cloud" is 13 chars, + 2 padding = 15
    const width = calculateColumnWidth(["Hetzner Cloud"], 10);
    expect(width).toBe(15);
  });

  it("should return max item width + padding for multiple long items", () => {
    const width = calculateColumnWidth(["short", "medium length", "very long cloud name"], 5);
    // "very long cloud name" is 20 chars + 2 padding = 22
    expect(width).toBe(22);
  });

  it("should handle empty items array", () => {
    const width = calculateColumnWidth([], 16);
    expect(width).toBe(16);
  });

  it("should handle single-char items", () => {
    const width = calculateColumnWidth(["a"], 10);
    // "a" is 1 char + 2 padding = 3, but min is 10
    expect(width).toBe(10);
  });

  it("should handle items with exact minimum width", () => {
    // Item length 8 + padding 2 = 10, equals minimum
    const width = calculateColumnWidth(["12345678"], 10);
    expect(width).toBe(10);
  });

  it("should handle items that exceed minimum by 1", () => {
    // Item length 9 + padding 2 = 11, exceeds minimum of 10
    const width = calculateColumnWidth(["123456789"], 10);
    expect(width).toBe(11);
  });
});

// ── getTerminalWidth ────────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  it("should return a positive number", () => {
    const width = getTerminalWidth();
    expect(width).toBeGreaterThan(0);
  });

  it("should return at least 80 (default fallback)", () => {
    // In test environment, process.stdout.columns may be undefined
    // which defaults to 80
    const width = getTerminalWidth();
    expect(width).toBeGreaterThanOrEqual(80);
  });
});

// ── Footer singular/plural forms via cmdList ────────────────────────────────

describe("footer singular/plural forms", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    originalFetch = global.fetch;
    originalEnv = { ...process.env };

    testDir = join(tmpdir(), `spawn-footer-plural-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;

    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  it("should use singular 'spawn' for exactly 1 record", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("1 spawn recorded");
    expect(output).not.toContain("1 spawns");
  });

  it("should use plural 'spawns' for 2 records", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "aider", cloud: "sprite", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("2 spawns recorded");
  });

  it("should use plural 'spawns' for many records", async () => {
    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push({
        agent: "claude",
        cloud: "sprite",
        timestamp: `2026-01-0${i + 1}T10:00:00.000Z`,
      });
    }
    writeHistory(records);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("5 spawns recorded");
  });

  it("should show 'Showing N of M' with singular when filtered to 1", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    await cmdList("aider");
    const output = getOutput();
    expect(output).toContain("Showing 1 of 2");
  });

  it("should show filter hint with -a flag when unfiltered", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
    ]);

    await cmdList();
    const output = getOutput();
    expect(output).toContain("spawn list -a");
  });

  it("should show 'Clear filter' hint when agent filter is active", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "aider", cloud: "sprite", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    await cmdList("claude");
    const output = getOutput();
    expect(output).toContain("Clear filter");
    expect(output).toContain("spawn list");
  });

  it("should show 'Clear filter' hint when cloud filter is active", async () => {
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "claude", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    await cmdList(undefined, "sprite");
    const output = getOutput();
    expect(output).toContain("Clear filter");
  });
});
