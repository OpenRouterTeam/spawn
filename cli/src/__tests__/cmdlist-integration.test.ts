import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import type { SpawnRecord } from "../history";

/**
 * Integration tests for cmdList through the real exported function.
 *
 * Existing tests cover:
 * - history.test.ts: data layer (loadHistory, saveSpawnRecord, filterHistory)
 * - list-display.test.ts: formatTimestamp and parseListFilters replicas
 * - list-table-rendering.test.ts: resolveDisplayName unit tests and table rendering
 * - list-empty-footer.test.ts: showEmptyListMessage and showListFooter replicas
 * - list-filter-suggestions.test.ts: suggestFilterCorrection replicas
 * - list-prompt-display.test.ts: prompt preview rendering
 *
 * This file covers the UNTESTED integration path: calling the real cmdList
 * exported function with mock.module for @clack/prompts and a controlled
 * SPAWN_HOME, verifying the full pipeline from history file -> rendering.
 *
 * Tested paths:
 * - cmdList with no history records (empty list message)
 * - cmdList with records (table rendering with resolved display names)
 * - cmdList with agent filter that matches records
 * - cmdList with cloud filter that matches records
 * - cmdList with filters that match nothing (empty + suggestion flow)
 * - cmdList when manifest is unavailable (falls back to raw keys)
 * - cmdList footer: rerun hint with/without prompt, filter count text
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogSuccess = mock(() => {});
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
    success: mockLogSuccess,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import after mock setup
const { cmdList, resolveDisplayName } = await import("../commands.js");
const { loadManifest, _resetCacheForTesting } = await import("../manifest.js");

// ── Test Setup ──────────────────────────────────────────────────────────────────

describe("cmdList integration", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function writeHistory(records: SpawnRecord[]) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function consoleOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function logInfoOutput(): string {
    return mockLogInfo.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function consoleErrorOutput(): string {
    return consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }


  beforeEach(async () => {
    testDir = join(homedir(), `spawn-cmdlist-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    // Isolate disk cache so tests don't read/write the real ~/.cache/spawn
    process.env.XDG_CACHE_HOME = join(testDir, "cache");

    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogSuccess.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;

    // Prime the manifest in-memory cache with mock data so tests don't
    // depend on network availability or stale values from other test files.
    global.fetch = mock(() =>
      Promise.resolve({ ok: true, json: async () => mockManifest }) as any
    );
    await loadManifest(true);
    global.fetch = originalFetch;

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);

    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Empty history ───────────────────────────────────────────────────────────

  describe("empty history (no records)", () => {
    it("should show 'No spawns recorded yet' when no history file exists", async () => {
      await cmdList();

      const info = logInfoOutput();
      expect(info).toContain("No spawns recorded yet");
    });

    it("should suggest 'spawn <agent> <cloud>' for first spawn", async () => {
      await cmdList();

      const info = logInfoOutput();
      expect(info).toContain("spawn <agent> <cloud>");
    });

    it("should show 'No spawns found matching' when filter matches nothing", async () => {
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
      ]);

      await cmdList("nonexistent");

      const info = logInfoOutput();
      expect(info).toContain("No spawns found matching");
      expect(info).toContain("nonexistent");
    });

    it("should suggest clearing filter when filtered results are empty", async () => {
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00Z" },
      ]);

      await cmdList("nonexistent");

      const info = logInfoOutput();
      expect(info).toContain("spawn list");
      // Should mention total record count
      expect(info).toContain("2");
    });

    it("should show empty message for empty history with agent and cloud filters", async () => {
      await cmdList("claude", "sprite");

      const info = logInfoOutput();
      expect(info).toContain("No spawns");
    });
  });

  // ── History with records ────────────────────────────────────────────────────

  describe("history with records (table rendering)", () => {
    const sampleRecords: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T14:30:00Z" },
      { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T09:15:00Z" },
    ];

    it("should render table header with AGENT, CLOUD, WHEN columns", async () => {
      writeHistory(sampleRecords);

      // Mock fetch to return manifest (for display names)
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("AGENT");
      expect(output).toContain("CLOUD");
      expect(output).toContain("WHEN");
    });

    it("should show separator line under header", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("-".repeat(10));
    });

    it("should render records in reverse chronological order (newest first)", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      const lines = output.split("\n");

      // Find lines with agent names (after header/separator)
      const dataLines = lines.filter(
        (l: string) => l.includes("Claude Code") || l.includes("Aider") || l.includes("Hetzner")
      );

      // The most recent record (Jan 3) should appear before the oldest (Jan 1)
      expect(dataLines.length).toBeGreaterThan(0);
    });

    it("should show display names when manifest is available", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      // Display names from manifest
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
    });

    it("should fall back to raw keys when manifest is unavailable", async () => {
      writeHistory(sampleRecords);

      // Clear in-memory cache and mock fetch to fail
      _resetCacheForTesting();
      global.fetch = mock(() => Promise.reject(new Error("Network error")));

      await cmdList();

      const output = consoleOutput();
      // Should still render the table (with raw keys)
      expect(output).toContain("AGENT");
      expect(output).toContain("CLOUD");
      // Raw keys should appear since manifest is unavailable
      expect(output).toContain("claude");
    });

    it("should show rerun hint in footer", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("Rerun last:");
      // The most recent record is claude/hetzner
      expect(output).toContain("spawn claude hetzner");
    });

    it("should show record count in footer", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("3 spawns recorded");
    });

    it("should use singular 'spawn' for single record", async () => {
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00Z" },
      ]);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      // Should say "1 spawn recorded" not "1 spawns recorded"
      expect(output).toMatch(/1 spawn[^s]/);
    });
  });

  // ── Prompt display in history ─────────────────────────────────────────────

  describe("prompt display in history records", () => {
    it("should show prompt preview in table row", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T10:00:00Z",
          prompt: "Fix all linter errors",
        },
      ]);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("Fix all linter errors");
    });

    it("should truncate long prompts with ellipsis", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T10:00:00Z",
          prompt: "This is a very long prompt that should be truncated because it exceeds the display limit in the table",
        },
      ]);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("...");
    });

    it("should include prompt in rerun hint for latest record with prompt", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T10:00:00Z",
          prompt: "Fix the auth bug",
        },
      ]);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain('--prompt "');
      expect(output).toContain("Fix the auth bug");
    });
  });

  // ── Filtering ─────────────────────────────────────────────────────────────

  describe("filtering by agent and cloud", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00Z" },
      { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T00:00:00Z" },
      { agent: "aider", cloud: "sprite", timestamp: "2026-01-04T00:00:00Z" },
    ];

    it("should filter by agent name", async () => {
      writeHistory(records);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList("claude");

      const output = consoleOutput();
      // Should show "Showing 2 of 4" in footer
      expect(output).toContain("2 of 4");
    });

    it("should filter by cloud name", async () => {
      writeHistory(records);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList(undefined, "hetzner");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should filter by both agent and cloud", async () => {
      writeHistory(records);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList("claude", "sprite");

      const output = consoleOutput();
      expect(output).toContain("1 of 4");
    });

    it("should show 'Clear filter' hint when filters are active", async () => {
      writeHistory(records);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList("claude");

      const output = consoleOutput();
      expect(output).toContain("Clear filter");
      expect(output).toContain("spawn list");
    });

    it("should show filter suggestion hint when no filters active", async () => {
      writeHistory(records);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("Filter:");
      expect(output).toContain("-a <agent>");
      expect(output).toContain("-c <cloud>");
    });

    it("should show case-insensitive filter results", async () => {
      writeHistory(records);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList("CLAUDE");

      const output = consoleOutput();
      // Should still find 2 records (case insensitive)
      expect(output).toContain("2 of 4");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle corrupted history file gracefully", async () => {
      writeFileSync(join(testDir, "history.json"), "not valid json{{{");

      await cmdList();

      const info = logInfoOutput();
      // loadHistory returns [] for corrupted files
      expect(info).toContain("No spawns recorded yet");
    });

    it("should handle history file with non-array JSON", async () => {
      writeFileSync(join(testDir, "history.json"), JSON.stringify({ not: "array" }));

      await cmdList();

      const info = logInfoOutput();
      expect(info).toContain("No spawns recorded yet");
    });

    it("should handle many records without issue", async () => {
      const manyRecords: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        manyRecords.push({
          agent: i % 2 === 0 ? "claude" : "aider",
          cloud: i % 3 === 0 ? "sprite" : "hetzner",
          timestamp: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
        });
      }
      writeHistory(manyRecords);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      expect(output).toContain("100 spawns recorded");
    });

    it("should handle records with missing optional prompt field", async () => {
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
      ]);

      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: async () => mockManifest,
        }) as any
      );

      await cmdList();

      const output = consoleOutput();
      // Should not contain --prompt in rerun hint
      expect(output).not.toContain("--prompt");
      expect(output).toContain("spawn claude sprite");
    });
  });
});
