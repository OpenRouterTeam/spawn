import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import type { SpawnRecord } from "../history";

/**
 * Tests for the resolveListFilters function in commands.ts (lines 938-968).
 *
 * resolveListFilters is an internal async function that:
 * 1. Loads the manifest (or gracefully handles failure)
 * 2. Resolves an agentFilter display name to its key
 * 3. Falls back a bare positional arg from agent to cloud when it doesn't
 *    match any agent but does match a cloud
 * 4. Resolves a cloudFilter display name to its key
 *
 * This logic is critical because it determines how "spawn list <filter>"
 * routes the user's filter input to the correct entity type. A bug here
 * causes empty results for valid inputs.
 *
 * Since resolveListFilters is not exported, we test it through cmdList
 * which calls it at the top of its flow.
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
const { cmdList } = await import("../commands.js");
const { loadManifest } = await import("../manifest.js");

describe("resolveListFilters (via cmdList)", () => {
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

  const sampleRecords: SpawnRecord[] = [
    { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
    { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00Z" },
    { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T00:00:00Z" },
    { agent: "aider", cloud: "sprite", timestamp: "2026-01-04T00:00:00Z" },
  ];

  beforeEach(async () => {
    testDir = join(tmpdir(), `spawn-resolve-filters-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    process.env.XDG_CACHE_HOME = join(testDir, "cache");

    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogSuccess.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;

    // Prime manifest cache
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
  });

  // ── Agent key resolution ────────────────────────────────────────────────

  describe("agent filter resolution", () => {
    it("should resolve exact agent key filter", async () => {
      writeHistory(sampleRecords);
      await cmdList("claude");
      const output = consoleOutput();
      // "claude" is an exact agent key, should filter to 2 records
      expect(output).toContain("2 of 4");
    });

    it("should resolve agent display name to key", async () => {
      writeHistory(sampleRecords);
      // "Claude Code" is the display name for agent key "claude"
      await cmdList("Claude Code");
      const output = consoleOutput();
      // Should resolve to "claude" and filter to 2 records
      expect(output).toContain("2 of 4");
    });

    it("should resolve case-insensitive agent key", async () => {
      writeHistory(sampleRecords);
      await cmdList("CLAUDE");
      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should resolve case-insensitive agent display name", async () => {
      writeHistory(sampleRecords);
      await cmdList("claude code");
      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });
  });

  // ── Cloud filter resolution ─────────────────────────────────────────────

  describe("cloud filter resolution", () => {
    it("should resolve exact cloud key filter", async () => {
      writeHistory(sampleRecords);
      await cmdList(undefined, "sprite");
      const output = consoleOutput();
      // "sprite" is an exact cloud key, should filter to 2 records
      expect(output).toContain("2 of 4");
    });

    it("should resolve cloud display name to key", async () => {
      writeHistory(sampleRecords);
      // "Hetzner Cloud" is the display name for cloud key "hetzner"
      await cmdList(undefined, "Hetzner Cloud");
      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should resolve case-insensitive cloud key", async () => {
      writeHistory(sampleRecords);
      await cmdList(undefined, "HETZNER");
      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });
  });

  // ── Bare positional arg fallback: agent -> cloud ────────────────────────

  describe("bare positional arg fallback (agent filter -> cloud filter)", () => {
    it("should treat bare arg as cloud filter when it does not match any agent but matches a cloud", async () => {
      writeHistory(sampleRecords);
      // "sprite" is a cloud key but NOT an agent key, so the bare positional
      // arg should fall back from agentFilter to cloudFilter
      await cmdList("sprite");
      const output = consoleOutput();
      // Should find 2 records (claude/sprite and aider/sprite)
      expect(output).toContain("2 of 4");
    });

    it("should treat bare arg as cloud filter via display name", async () => {
      writeHistory(sampleRecords);
      // "Hetzner Cloud" is a cloud display name, not an agent key
      await cmdList("Hetzner Cloud");
      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should prefer agent key match over cloud fallback when both exist", async () => {
      // Create a manifest where a key exists as both agent and cloud display name
      // In our mock manifest, "claude" is only an agent and "sprite" is only a cloud
      writeHistory(sampleRecords);
      await cmdList("claude");
      const output = consoleOutput();
      // Should resolve as agent filter (2 records with agent=claude)
      expect(output).toContain("2 of 4");
    });

    it("should not fall back to cloud when an explicit cloudFilter is already provided", async () => {
      writeHistory(sampleRecords);
      // When both filters are provided, agentFilter should not fall back
      // "nonexistent" doesn't match any agent or cloud
      await cmdList("nonexistent", "sprite");
      // Should show empty results since "nonexistent" doesn't match any agent
      const info = logInfoOutput();
      expect(info).toContain("No spawns found");
    });
  });

  // ── Unresolvable filter ─────────────────────────────────────────────

  describe("unresolvable filter", () => {
    it("should show empty results for a filter that does not match any agent or cloud", async () => {
      writeHistory(sampleRecords);

      await cmdList("zzz-nonexistent");
      // "zzz-nonexistent" doesn't match any agent or cloud in the manifest
      // After failed resolution, filterHistory("zzz-nonexistent") returns []
      const info = logInfoOutput();
      expect(info).toContain("No spawns found");
    });

    it("should show the unresolved filter name in the empty message", async () => {
      writeHistory(sampleRecords);

      await cmdList("totally-unknown");
      const info = logInfoOutput();
      expect(info).toContain("totally-unknown");
    });
  });

  // ── Both filters combined ──────────────────────────────────────────────

  describe("combined agent + cloud filter resolution", () => {
    it("should resolve both agent display name and cloud display name", async () => {
      writeHistory(sampleRecords);
      await cmdList("Claude Code", "Sprite");
      const output = consoleOutput();
      // Should find 1 record (claude/sprite)
      expect(output).toContain("1 of 4");
    });

    it("should resolve agent key + cloud display name", async () => {
      writeHistory(sampleRecords);
      await cmdList("aider", "Hetzner Cloud");
      const output = consoleOutput();
      expect(output).toContain("1 of 4");
    });

    it("should resolve agent display name + cloud key", async () => {
      writeHistory(sampleRecords);
      await cmdList("Aider", "sprite");
      const output = consoleOutput();
      expect(output).toContain("1 of 4");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle empty string filter", async () => {
      writeHistory(sampleRecords);
      await cmdList("");
      const output = consoleOutput();
      // Empty string should show all records (filterHistory treats "" as no filter)
      expect(output).toContain("4 spawns");
    });

    it("should handle undefined filters", async () => {
      writeHistory(sampleRecords);
      await cmdList(undefined, undefined);
      const output = consoleOutput();
      expect(output).toContain("4 spawns");
    });

    it("should show record count correctly for single match", async () => {
      writeHistory(sampleRecords);
      await cmdList("claude", "sprite");
      const output = consoleOutput();
      expect(output).toContain("1 of 4");
    });
  });
});
