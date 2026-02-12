import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest, _resetCacheForTesting } from "../manifest";
import type { Manifest } from "../manifest";

/**
 * Tests for resolveListFilters, showListFooter prompt escaping, and
 * showEmptyListMessage suggestion paths in commands.ts.
 *
 * resolveListFilters (commands.ts:938-968) resolves display names and
 * case-insensitive keys for list filtering. It also implements a fallback
 * where a bare positional arg that doesn't match an agent is tried as a
 * cloud filter. Previously untested paths:
 *
 * - Bare positional arg falling back from agent to cloud filter
 * - Case-insensitive agent filter resolution ("CLAUDE" -> "claude")
 * - Case-insensitive cloud filter resolution ("HETZNER" -> "hetzner")
 * - Display name resolution for cloud filter ("Hetzner Cloud" -> "hetzner")
 * - Display name resolution for agent filter ("Claude Code" -> "claude")
 * - Manifest unavailable: raw keys used as-is (no resolution)
 *
 * showListFooter (commands.ts:864-883) prompt escaping:
 * - Double-quote escaping in rerun hint for prompts containing quotes
 * - Prompt truncation at 30 chars in footer rerun hint
 *
 * showEmptyListMessage (commands.ts:834-862) suggestion paths:
 * - Suggests typo correction for agent filter via suggestFilterCorrection
 * - Suggests typo correction for cloud filter via suggestFilterCorrection
 * - Falls back to "see all N spawns" when filters match nothing
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
const { cmdList } = await import("../commands.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function clearMocks() {
  mockLogError.mockClear();
  mockLogInfo.mockClear();
  mockLogStep.mockClear();
  mockSpinnerStart.mockClear();
  mockSpinnerStop.mockClear();
}

// ── resolveListFilters: bare positional arg fallback ────────────────────────

describe("resolveListFilters via cmdList", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getLogOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  function getInfoOutput(): string {
    return mockLogInfo.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    clearMocks();
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    testDir = join(tmpdir(), `spawn-list-filter-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Bare positional arg: agent match ──────────────────────────────────

  describe("bare positional arg as agent filter", () => {
    it("should use bare positional arg as agent filter when it matches an agent key", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList("claude");
      const output = getLogOutput();
      // Should show only claude records
      expect(output).toContain("Claude Code");
      expect(output).not.toContain("Aider");
    });
  });

  // ── Bare positional arg: fallback to cloud filter ─────────────────────

  describe("bare positional arg fallback to cloud filter", () => {
    it("should try bare arg as cloud filter when it does not match an agent", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T10:00:00.000Z" },
      ]);

      // "sprite" is not an agent key, so it should fall back to cloud filter
      await cmdList("sprite");
      const output = getLogOutput();
      // Should show only records with cloud=sprite
      expect(output).toContain("Sprite");
      expect(output).not.toContain("Hetzner Cloud");
    });

    it("should resolve cloud display name when falling back to cloud filter", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      // "Sprite" (display name) is not an agent key, should fall back and resolve as cloud
      await cmdList("Sprite");
      const output = getLogOutput();
      // Should filter by cloud=sprite
      expect(output).toContain("Claude Code");
      expect(output).not.toContain("Aider");
    });

    it("should resolve case-insensitive cloud key when falling back", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "sprite", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      // "HETZNER" is not an agent key, should fall back to cloud filter
      await cmdList("HETZNER");
      const output = getLogOutput();
      expect(output).toContain("Hetzner Cloud");
      expect(output).not.toContain("Sprite");
    });
  });

  // ── Case-insensitive agent filter resolution ──────────────────────────

  describe("case-insensitive agent filter resolution", () => {
    it("should resolve uppercase agent key", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList("CLAUDE");
      const output = getLogOutput();
      expect(output).toContain("Claude Code");
      expect(output).not.toContain("Aider");
    });

    it("should resolve mixed-case agent key", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList("Claude");
      const output = getLogOutput();
      expect(output).toContain("Claude Code");
      expect(output).not.toContain("Aider");
    });
  });

  // ── Display name resolution for agent filter ──────────────────────────

  describe("display name resolution for agent filter", () => {
    it("should resolve agent display name to key", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      // "Claude Code" is the display name for "claude" agent
      await cmdList("Claude Code");
      const output = getLogOutput();
      expect(output).toContain("Claude Code");
      expect(output).not.toContain("Aider");
    });
  });

  // ── Explicit cloud filter resolution ──────────────────────────────────

  describe("explicit cloud filter resolution", () => {
    it("should resolve case-insensitive cloud key with -c flag", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList(undefined, "SPRITE");
      const output = getLogOutput();
      expect(output).toContain("Sprite");
      expect(output).not.toContain("Hetzner Cloud");
    });

    it("should resolve cloud display name with -c flag", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "sprite", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList(undefined, "Hetzner Cloud");
      const output = getLogOutput();
      expect(output).toContain("Hetzner Cloud");
      expect(output).not.toContain("Sprite");
    });
  });

  // ── Manifest unavailable: raw keys used as-is ─────────────────────────

  describe("manifest unavailable", () => {
    it("should use raw filter key when manifest fetch fails", async () => {
      global.fetch = mock(async () => {
        throw new Error("Network error");
      }) as any;
      _resetCacheForTesting();
      try { await loadManifest(true); } catch { /* expected */ }

      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      // No manifest to resolve from - should filter on raw key
      await cmdList("claude");
      const output = getLogOutput();
      // Should still match records where agent === "claude"
      expect(output).toContain("claude");
    });
  });

  // ── Both filters combined ─────────────────────────────────────────────

  describe("combined agent and cloud filters", () => {
    it("should resolve both agent and cloud filters from display names", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
        { agent: "aider", cloud: "sprite", timestamp: "2026-01-03T10:00:00.000Z" },
      ]);

      await cmdList("claude", "sprite");
      const output = getLogOutput();
      expect(output).toContain("Claude Code");
      expect(output).toContain("Sprite");
      // Should show only the 1 matching record (claude on sprite)
      expect(output).toContain("Showing 1 of 3");
    });
  });
});

// ── showListFooter: prompt escaping ───────────────────────────────────────

describe("showListFooter prompt escaping", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getLogOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    clearMocks();
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    testDir = join(tmpdir(), `spawn-list-footer-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should escape double quotes in rerun hint prompt", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z", prompt: 'Fix "bug" here' },
    ]);

    await cmdList();
    const output = getLogOutput();
    // The rerun hint should have escaped double quotes for valid shell
    expect(output).toContain('Fix \\"bug\\" here');
  });

  it("should truncate rerun hint prompt at 30 chars and escape quotes", async () => {
    await setManifest(mockManifest);
    // Prompt with quotes beyond the 30-char truncation boundary
    const prompt = 'Fix "all the bugs" and also "add new features" please';
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z", prompt },
    ]);

    await cmdList();
    const output = getLogOutput();
    // Should be truncated to 30 chars + "..."
    expect(output).toContain("...");
    // The original 53-char prompt should not appear in full
    expect(output).not.toContain('please');
  });

  it("should show exact 30-char prompt without truncation in rerun hint", async () => {
    await setManifest(mockManifest);
    const exactPrompt = "D".repeat(30);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z", prompt: exactPrompt },
    ]);

    await cmdList();
    const output = getLogOutput();
    expect(output).toContain("D".repeat(30));
    // Should not have ellipsis since it's exactly 30
    const rerunLine = consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .find((l: string) => l.includes("Rerun last"));
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).not.toContain("D".repeat(30) + "...");
  });

  it("should truncate 31-char prompt in rerun hint", async () => {
    await setManifest(mockManifest);
    const prompt31 = "E".repeat(31);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z", prompt: prompt31 },
    ]);

    await cmdList();
    const output = getLogOutput();
    expect(output).toContain("E".repeat(30) + "...");
  });

  it("should not show --prompt in rerun hint when latest record has no prompt", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z", prompt: "Fix bugs" },
      // Latest record (will be first after reverse) has no prompt
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    await cmdList();
    const rerunLine = consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .find((l: string) => l.includes("Rerun last"));
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).not.toContain("--prompt");
    expect(rerunLine!).toContain("spawn aider hetzner");
  });

  it("should show --prompt in rerun hint when latest record has prompt", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-01T10:00:00.000Z" },
      // Latest record has prompt
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-02T10:00:00.000Z", prompt: "Add tests" },
    ]);

    await cmdList();
    const rerunLine = consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .find((l: string) => l.includes("Rerun last"));
    expect(rerunLine).toBeDefined();
    expect(rerunLine!).toContain('--prompt "Add tests"');
    expect(rerunLine!).toContain("spawn claude sprite");
  });
});

// ── showEmptyListMessage: filter suggestion paths ─────────────────────────

describe("showEmptyListMessage suggestions", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getInfoOutput(): string {
    return mockLogInfo.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    clearMocks();
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    testDir = join(tmpdir(), `spawn-list-empty-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should show 'No spawns recorded yet' when no history and no filter", async () => {
    await setManifest(mockManifest);
    // No history file at all
    await cmdList();
    const output = getInfoOutput();
    expect(output).toContain("No spawns recorded yet");
  });

  it("should show 'No spawns found matching' when filter matches nothing", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
    ]);

    await cmdList("nonexistent");
    const output = getInfoOutput();
    expect(output).toContain("No spawns found matching");
  });

  it("should suggest 'spawn list' to see all records when filter matches nothing", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    await cmdList("nonexistent");
    const output = getInfoOutput();
    expect(output).toContain("spawn list");
    expect(output).toContain("2"); // total count of records
  });

  it("should suggest first spawn command when no history exists", async () => {
    await setManifest(mockManifest);
    await cmdList();
    const output = getInfoOutput();
    expect(output).toContain("spawn");
    expect(output).toContain("launch");
  });

  it("should suggest typo correction for agent filter that is close to a valid key", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
    ]);

    // "claud" is 1 edit away from "claude" (within Levenshtein distance 3)
    await cmdList("claud");
    const output = getInfoOutput();
    // Should suggest correction
    expect(output).toContain("Did you mean");
    expect(output).toContain("claude");
  });

  it("should suggest typo correction for cloud filter that is close to a valid key", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
    ]);

    // Filter by cloud with typo: "sprit" is 1 edit away from "sprite"
    await cmdList(undefined, "sprit");
    const output = getInfoOutput();
    expect(output).toContain("Did you mean");
    expect(output).toContain("sprite");
  });

  it("should not suggest correction when filter is too far from any key", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
    ]);

    // "zzzzzzz" is far from any agent/cloud key
    await cmdList("zzzzzzz");
    const output = getInfoOutput();
    expect(output).not.toContain("Did you mean");
  });

  it("should show matching filter names in the 'No spawns found' message", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
    ]);

    await cmdList("aider", "hetzner");
    const output = getInfoOutput();
    expect(output).toContain("aider");
    expect(output).toContain("hetzner");
  });
});

// ── resolveListFilters: display name resolution with both filters ────────

describe("resolveListFilters: both filters with resolution", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getLogOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    clearMocks();
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    testDir = join(tmpdir(), `spawn-list-both-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should resolve case-insensitive keys for both agent and cloud filters", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "claude", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      { agent: "aider", cloud: "sprite", timestamp: "2026-01-03T10:00:00.000Z" },
    ]);

    await cmdList("CLAUDE", "SPRITE");
    const output = getLogOutput();
    expect(output).toContain("Claude Code");
    expect(output).toContain("Sprite");
    expect(output).toContain("Showing 1 of 3");
  });

  it("should not fall back agent to cloud when cloudFilter is already provided", async () => {
    await setManifest(mockManifest);
    writeHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
    ]);

    // "sprite" as agent filter with explicit cloud filter "hetzner"
    // Even though "sprite" doesn't match an agent, it should NOT fall back
    // to cloud filter because cloudFilter is already provided
    await cmdList("sprite", "hetzner");
    const output = getLogOutput();
    // "sprite" doesn't match any agent, so no records should match
    // (filter looks for agent=sprite AND cloud=hetzner - no such record)
    expect(output).not.toContain("AGENT"); // no table header = empty results
  });
});
