import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadHistory, saveSpawnRecord, filterHistory, type SpawnRecord } from "../history.js";

/**
 * Tests for history trimming and boundary behavior.
 *
 * The saveSpawnRecord function has a MAX_HISTORY_ENTRIES = 100 cap that
 * trims old entries when history grows too large. This prevents unbounded
 * growth of the history.json file but must correctly preserve the most
 * recent entries and not lose data prematurely.
 *
 * Also tests filterHistory ordering guarantees (reverse chronological).
 *
 * Agent: test-engineer
 */

describe("History Trimming and Boundaries", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(homedir(), `spawn-history-trim-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    originalEnv = {
      ...process.env,
    };
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    }
  });

  // ── MAX_HISTORY_ENTRIES trimming ────────────────────────────────────────

  describe("MAX_HISTORY_ENTRIES trimming (100 entries)", () => {
    it("should keep all entries when at exactly 100", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 99; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Adding one more brings us to exactly 100
      saveSpawnRecord({
        agent: "agent-99",
        cloud: "cloud-99",
        timestamp: "2026-01-01T01:39:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // First entry should still be agent-0 (nothing trimmed)
      expect(loaded[0].agent).toBe("agent-0");
      expect(loaded[99].agent).toBe("agent-99");
    });

    it("should trim to 100 when adding entry that exceeds the limit", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Adding 101st entry should trigger trimming
      saveSpawnRecord({
        agent: "agent-100",
        cloud: "cloud-100",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // The oldest entry (agent-0) should be trimmed
      expect(loaded[0].agent).toBe("agent-1");
      // The newest entry should be the one we just added
      expect(loaded[99].agent).toBe("agent-100");
    });

    it("should trim correctly when history is well over the limit", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 150; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-${String(Math.floor(i / 24) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Adding another entry to 150 existing entries
      saveSpawnRecord({
        agent: "agent-150",
        cloud: "cloud-150",
        timestamp: "2026-01-10T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // Should keep the most recent 100 entries: agent-51 through agent-150
      expect(loaded[0].agent).toBe("agent-51");
      expect(loaded[99].agent).toBe("agent-150");
    });

    it("should not trim when history has fewer than 100 entries", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 50; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "agent-50",
        cloud: "cloud-50",
        timestamp: "2026-01-01T00:50:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(51);
      expect(loaded[0].agent).toBe("agent-0");
      expect(loaded[50].agent).toBe("agent-50");
    });

    it("should preserve prompt fields through trimming", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
          ...(i >= 90
            ? {
                prompt: `Prompt for agent-${i}`,
              }
            : {}),
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "agent-100",
        cloud: "cloud-100",
        timestamp: "2026-01-02T00:00:00.000Z",
        prompt: "Final prompt",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // Check that prompts survive trimming for remaining entries
      const withPrompts = loaded.filter((r) => r.prompt);
      expect(withPrompts.length).toBe(11); // agents 90-99 + agent-100
      expect(withPrompts[withPrompts.length - 1].prompt).toBe("Final prompt");
    });

    it("should handle sequential saves that cross the limit", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 98; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Save 3 more (98 + 3 = 101, triggers trim at 101)
      saveSpawnRecord({
        agent: "new-98",
        cloud: "cloud",
        timestamp: "2026-02-01T00:00:00.000Z",
      });
      saveSpawnRecord({
        agent: "new-99",
        cloud: "cloud",
        timestamp: "2026-02-02T00:00:00.000Z",
      });
      saveSpawnRecord({
        agent: "new-100",
        cloud: "cloud",
        timestamp: "2026-02-03T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // The newest entry should be last
      expect(loaded[loaded.length - 1].agent).toBe("new-100");
      expect(loaded[loaded.length - 2].agent).toBe("new-99");
      expect(loaded[loaded.length - 3].agent).toBe("new-98");
      // agent-0 should be trimmed since we went from 98 to 101
      expect(loaded[0].agent).toBe("agent-1");
    });
  });

  // ── filterHistory reverse chronological ordering ────────────────────────

  describe("filterHistory ordering guarantees", () => {
    it("should return records in reverse chronological order (newest first)", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const result = filterHistory();
      expect(result).toHaveLength(3);
      // Newest should be first (reverse of file order)
      expect(result[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
      expect(result[1].timestamp).toBe("2026-01-02T00:00:00.000Z");
      expect(result[2].timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should maintain reverse order after filtering by agent", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
        {
          agent: "codex",
          cloud: "sprite",
          timestamp: "2026-01-04T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const result = filterHistory("claude");
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
      expect(result[1].timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should maintain reverse order after filtering by cloud", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const result = filterHistory(undefined, "sprite");
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
      expect(result[1].timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should maintain reverse order after filtering by both agent and cloud", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          agent: "codex",
          cloud: "sprite",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-04T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const result = filterHistory("claude", "sprite");
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe("2026-01-04T00:00:00.000Z");
      expect(result[1].timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should return single-element array unchanged for one matching record", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const result = filterHistory();
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("claude");
    });
  });

  // ── Boundary: empty and single-entry history ────────────────────────────

  describe("boundary conditions", () => {
    it("should handle saving to empty history", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("claude");
    });

    it("should handle saving when history file does not exist yet", () => {
      // testDir exists but history.json does not
      expect(existsSync(join(testDir, "history.json"))).toBe(false);

      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      expect(existsSync(join(testDir, "history.json"))).toBe(true);
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
    });

    it("should handle saving when SPAWN_HOME directory does not exist", () => {
      const deepDir = join(testDir, "deep", "nested", "path");
      process.env.SPAWN_HOME = deepDir;
      expect(existsSync(deepDir)).toBe(false);

      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      expect(existsSync(deepDir)).toBe(true);
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
    });

    it("should filter correctly on empty history", () => {
      expect(filterHistory("claude")).toEqual([]);
      expect(filterHistory(undefined, "sprite")).toEqual([]);
      expect(filterHistory("claude", "sprite")).toEqual([]);
    });

    it("should handle loading history with extra unexpected fields gracefully", () => {
      const records = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
          extra_field: "should not break",
          nested: {
            foo: "bar",
          },
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("claude");
      expect(loaded[0].cloud).toBe("sprite");
    });

    it("should handle history file containing empty array", () => {
      writeFileSync(join(testDir, "history.json"), "[]");
      const loaded = loadHistory();
      expect(loaded).toEqual([]);
    });
  });

  // ── Trimming preserves file format ──────────────────────────────────────

  describe("file format after trimming", () => {
    it("should write valid JSON after trimming", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "agent-100",
        cloud: "cloud-100",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      // Read raw file and verify it's valid JSON
      const raw = readFileSync(join(testDir, "history.json"), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(100);
    });

    it("should write pretty-printed JSON with trailing newline after trimming", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "agent-100",
        cloud: "cloud-100",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const raw = readFileSync(join(testDir, "history.json"), "utf-8");
      // Pretty-printed JSON has indentation
      expect(raw).toContain("  ");
      // Trailing newline
      expect(raw.endsWith("\n")).toBe(true);
    });
  });

  // ── Race-like sequential saves near the boundary ────────────────────────

  describe("sequential saves at the boundary", () => {
    it("should correctly handle saving from exactly 99 to 100 entries", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 99; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "agent-99",
        cloud: "cloud",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // No trimming should have happened
      expect(loaded[0].agent).toBe("agent-0");
    });

    it("should correctly handle saving from exactly 100 to 101 entries (trim boundary)", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "agent-100",
        cloud: "cloud",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // Oldest entry should be trimmed
      expect(loaded[0].agent).toBe("agent-1");
      expect(loaded[99].agent).toBe("agent-100");
    });

    it("should handle rapid sequential saves that build up from zero", () => {
      for (let i = 0; i < 105; i++) {
        saveSpawnRecord({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        });
      }

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // Should have the most recent 100 entries: agent-5 through agent-104
      expect(loaded[0].agent).toBe("agent-5");
      expect(loaded[99].agent).toBe("agent-104");
    });
  });
});
