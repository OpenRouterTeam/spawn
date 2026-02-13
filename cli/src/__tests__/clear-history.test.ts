import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearHistory,
  loadHistory,
  saveSpawnRecord,
  filterHistory,
  getHistoryPath,
  type SpawnRecord,
} from "../history.js";

/**
 * Tests for clearHistory (history.ts) and cmdListClear (commands.ts).
 *
 * clearHistory is invoked via `spawn list --clear` and performs a destructive
 * operation (deleting the history file). It has zero existing test coverage.
 * cmdListClear wraps clearHistory with user-facing output and also has
 * zero existing test coverage.
 *
 * Agent: test-engineer
 */

describe("clearHistory", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-clear-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Basic clearing ─────────────────────────────────────────────────────

  describe("basic clearing", () => {
    it("should return 0 when history file does not exist", () => {
      expect(clearHistory()).toBe(0);
    });

    it("should return 0 when history file contains empty array", () => {
      writeFileSync(join(testDir, "history.json"), "[]");
      expect(clearHistory()).toBe(0);
      // File should still exist since there were no records
      expect(existsSync(join(testDir, "history.json"))).toBe(true);
    });

    it("should return 1 and delete file when history has one record", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      expect(clearHistory()).toBe(1);
      expect(existsSync(join(testDir, "history.json"))).toBe(false);
    });

    it("should return count and delete file when history has multiple records", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T00:00:00.000Z" },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      expect(clearHistory()).toBe(3);
      expect(existsSync(join(testDir, "history.json"))).toBe(false);
    });

    it("should delete the file completely, not just empty it", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      clearHistory();
      expect(existsSync(join(testDir, "history.json"))).toBe(false);
    });

    it("should not delete the SPAWN_HOME directory itself", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      clearHistory();
      expect(existsSync(testDir)).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle corrupted JSON gracefully and return 0", () => {
      writeFileSync(join(testDir, "history.json"), "not valid json{{{");
      // loadHistory returns [] for corrupted files, so count is 0
      expect(clearHistory()).toBe(0);
    });

    it("should handle history file containing a JSON object (not array)", () => {
      writeFileSync(join(testDir, "history.json"), JSON.stringify({ not: "array" }));
      // loadHistory returns [] for non-array values, so count is 0
      expect(clearHistory()).toBe(0);
    });

    it("should handle history file containing a JSON string", () => {
      writeFileSync(join(testDir, "history.json"), JSON.stringify("just a string"));
      expect(clearHistory()).toBe(0);
    });

    it("should handle history file containing null", () => {
      writeFileSync(join(testDir, "history.json"), "null");
      expect(clearHistory()).toBe(0);
    });

    it("should handle empty file", () => {
      writeFileSync(join(testDir, "history.json"), "");
      expect(clearHistory()).toBe(0);
    });

    it("should handle records with prompt field in count", () => {
      const records: SpawnRecord[] = [
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z", prompt: "Fix bugs" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      expect(clearHistory()).toBe(2);
    });
  });

  // ── Interaction with other history operations ──────────────────────────

  describe("interaction with save and load", () => {
    it("should allow saving after clearing", () => {
      // Save initial records
      saveSpawnRecord({ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" });
      expect(loadHistory()).toHaveLength(1);

      // Clear
      clearHistory();
      expect(loadHistory()).toHaveLength(0);

      // Save new records after clearing
      saveSpawnRecord({ agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" });
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("aider");
    });

    it("should result in empty filterHistory after clearing", () => {
      saveSpawnRecord({ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" });
      saveSpawnRecord({ agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" });

      expect(filterHistory()).toHaveLength(2);
      expect(filterHistory("claude")).toHaveLength(1);

      clearHistory();

      expect(filterHistory()).toHaveLength(0);
      expect(filterHistory("claude")).toHaveLength(0);
      expect(filterHistory(undefined, "sprite")).toHaveLength(0);
    });

    it("should return correct count for exactly MAX_HISTORY_ENTRIES records", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      expect(clearHistory()).toBe(100);
      expect(existsSync(join(testDir, "history.json"))).toBe(false);
    });

    it("should be idempotent -- calling clear twice returns 0 on second call", () => {
      saveSpawnRecord({ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" });

      expect(clearHistory()).toBe(1);
      expect(clearHistory()).toBe(0);
    });

    it("should clear records that were saved across multiple sequential saves", () => {
      for (let i = 0; i < 10; i++) {
        saveSpawnRecord({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }

      expect(loadHistory()).toHaveLength(10);
      expect(clearHistory()).toBe(10);
      expect(loadHistory()).toHaveLength(0);
    });

    it("should not affect getHistoryPath after clearing", () => {
      saveSpawnRecord({ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" });
      const pathBefore = getHistoryPath();

      clearHistory();

      const pathAfter = getHistoryPath();
      expect(pathAfter).toBe(pathBefore);
    });
  });
});

// ── cmdListClear via mock.module ─────────────────────────────────────────────

const mockLogInfo = mock(() => {});
const mockLogSuccess = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mockLogInfo,
    error: mock(() => {}),
    warn: mock(() => {}),
    success: mockLogSuccess,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
  confirm: mock(() => Promise.resolve(true)),
}));

// Import after mock setup
const { cmdListClear } = await import("../commands.js");

describe("cmdListClear", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-cmdclear-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    mockLogInfo.mockClear();
    mockLogSuccess.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should call log.info when no history exists", () => {
    cmdListClear();
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    const msg = mockLogInfo.mock.calls[0][0] as string;
    expect(msg).toContain("No spawn history to clear");
  });

  it("should call log.success with count when clearing records", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    cmdListClear();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    const msg = mockLogSuccess.mock.calls[0][0] as string;
    expect(msg).toContain("Cleared 2 spawn records from history");
  });

  it("should use singular 'record' for a single entry", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    cmdListClear();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    const msg = mockLogSuccess.mock.calls[0][0] as string;
    expect(msg).toContain("Cleared 1 spawn record from history");
    // Should NOT say "records" (plural)
    expect(msg).not.toContain("Cleared 1 spawn records");
  });

  it("should actually delete the history file", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    cmdListClear();
    expect(existsSync(join(testDir, "history.json"))).toBe(false);
  });

  it("should handle empty array history file as no history", () => {
    writeFileSync(join(testDir, "history.json"), "[]");

    cmdListClear();
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).not.toHaveBeenCalled();
    const msg = mockLogInfo.mock.calls[0][0] as string;
    expect(msg).toContain("No spawn history to clear");
  });

  it("should handle corrupted history file as no history", () => {
    writeFileSync(join(testDir, "history.json"), "corrupt{{{");

    cmdListClear();
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).not.toHaveBeenCalled();
    const msg = mockLogInfo.mock.calls[0][0] as string;
    expect(msg).toContain("No spawn history to clear");
  });

  it("should display correct count for large history", () => {
    const records: SpawnRecord[] = [];
    for (let i = 0; i < 50; i++) {
      records.push({
        agent: `agent-${i}`,
        cloud: `cloud-${i}`,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    }
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    cmdListClear();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    const msg = mockLogSuccess.mock.calls[0][0] as string;
    expect(msg).toContain("Cleared 50 spawn records from history");
  });

  it("should allow saving new records after clearing via cmdListClear", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    cmdListClear();

    // Save new record after clearing
    saveSpawnRecord({ agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" });
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].agent).toBe("aider");
  });

  it("should use log.info for zero records and log.success for non-zero", () => {
    // Test with zero
    cmdListClear();
    expect(mockLogInfo).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).not.toHaveBeenCalled();

    // Reset mocks
    mockLogInfo.mockClear();
    mockLogSuccess.mockClear();

    // Test with records
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
    cmdListClear();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});
