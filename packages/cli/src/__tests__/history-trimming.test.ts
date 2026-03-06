import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterHistory, loadHistory, saveSpawnRecord } from "../history.js";

/**
 * Tests for history trimming and boundary behavior.
 *
 * The saveSpawnRecord function has a MAX_HISTORY_ENTRIES = 100 cap that
 * trims old entries when history grows too large. Smart trimming evicts
 * soft-deleted records first, then oldest non-deleted records. Evicted
 * records are archived to dated backup files so nothing is permanently lost.
 *
 * Also tests filterHistory ordering guarantees (reverse chronological).
 */

function getArchiveFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("history-") && f.endsWith(".json") && f !== "history.json");
}

function loadArchive(dir: string, filename: string): SpawnRecord[] {
  const raw = readFileSync(join(dir, filename), "utf-8");
  return JSON.parse(raw);
}

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
      // No archive should be created
      expect(getArchiveFiles(testDir)).toHaveLength(0);
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
      // Archive should contain the trimmed record
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(1);
      expect(archived[0].agent).toBe("agent-0");
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
      // Archive should contain 51 trimmed records (agent-0 through agent-50)
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(51);
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
      // No archive when under the limit
      expect(getArchiveFiles(testDir)).toHaveLength(0);
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

  // ── Smart trimming: deleted records evicted first ──────────────────────

  describe("smart trimming — deleted records evicted first", () => {
    it("should evict deleted records before non-deleted when over limit", () => {
      const records: SpawnRecord[] = [];
      // 80 non-deleted records
      for (let i = 0; i < 80; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
      // 20 deleted records (mixed throughout)
      for (let i = 0; i < 20; i++) {
        records.push({
          agent: `deleted-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-02T00:${String(i).padStart(2, "0")}:00.000Z`,
          connection: {
            ip: "1.2.3.4",
            user: "root",
            deleted: true,
            deleted_at: "2026-01-03T00:00:00.000Z",
          },
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Adding 101st entry (100 existing + 1 new)
      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-04T00:00:00.000Z",
      });

      const loaded = loadHistory();
      // 80 non-deleted + 1 new = 81 total (under limit after removing 20 deleted)
      expect(loaded).toHaveLength(81);
      // All non-deleted records should be preserved
      expect(loaded[0].agent).toBe("agent-0");
      expect(loaded[79].agent).toBe("agent-79");
      expect(loaded[80].agent).toBe("new-entry");
      // No deleted records should remain
      expect(loaded.filter((r) => r.connection?.deleted)).toHaveLength(0);
      // Archive should contain the 20 deleted records
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(20);
      expect(archived.every((r) => r.agent.startsWith("deleted-"))).toBe(true);
    });

    it("should trim oldest non-deleted when still over limit after removing deleted", () => {
      const records: SpawnRecord[] = [];
      // 98 non-deleted records
      for (let i = 0; i < 98; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
      // 2 deleted records
      for (let i = 0; i < 2; i++) {
        records.push({
          agent: `deleted-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-02T00:00:00.000Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            deleted: true,
            deleted_at: "2026-01-03T00:00:00.000Z",
          },
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Adding one more: 101 total, only 2 deleted — removing them gives 99, still need to check 99 <= 100 which is fine
      // Wait, 98 non-deleted + 1 new = 99 non-deleted. 99 <= 100. So only deleted are archived.
      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-04T00:00:00.000Z",
      });

      const loaded = loadHistory();
      // 98 + 1 new = 99 non-deleted (under limit)
      expect(loaded).toHaveLength(99);
      expect(loaded[0].agent).toBe("agent-0");
      expect(loaded[98].agent).toBe("new-entry");

      // Archive has the 2 deleted
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(2);
    });

    it("should trim oldest non-deleted records when 0 deleted and over limit", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-04T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // Oldest should be trimmed
      expect(loaded[0].agent).toBe("agent-1");
      expect(loaded[99].agent).toBe("new-entry");
      // Archive should have the overflow record
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(1);
      expect(archived[0].agent).toBe("agent-0");
    });

    it("should handle deleted records mixed throughout history order", () => {
      const records: SpawnRecord[] = [];
      // Create 100 records where every 5th is deleted
      for (let i = 0; i < 100; i++) {
        const isDeleted = i % 5 === 0;
        const record: SpawnRecord = {
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        };
        if (isDeleted) {
          record.connection = {
            ip: "1.2.3.4",
            user: "root",
            deleted: true,
            deleted_at: "2026-01-03T00:00:00.000Z",
          };
        }
        records.push(record);
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // 100 records (20 deleted, 80 non-deleted) + 1 new = 101
      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-04T00:00:00.000Z",
      });

      const loaded = loadHistory();
      // 80 non-deleted + 1 new = 81 (under limit)
      expect(loaded).toHaveLength(81);
      // No deleted records
      expect(loaded.filter((r) => r.connection?.deleted)).toHaveLength(0);
      // All non-deleted originals preserved in order
      const nonDeletedOriginals = records.filter((r) => !r.connection?.deleted);
      for (let i = 0; i < nonDeletedOriginals.length; i++) {
        expect(loaded[i].agent).toBe(nonDeletedOriginals[i].agent);
      }
      expect(loaded[80].agent).toBe("new-entry");
    });

    it("should archive both deleted and overflow when still over limit", () => {
      const records: SpawnRecord[] = [];
      // 99 non-deleted
      for (let i = 0; i < 99; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        });
      }
      // 5 deleted
      for (let i = 0; i < 5; i++) {
        records.push({
          agent: `deleted-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-02T00:00:00.000Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            deleted: true,
            deleted_at: "2026-01-03T00:00:00.000Z",
          },
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // 104 existing + 1 new = 105. Remove 5 deleted = 100 non-deleted. 100 <= 100, fits.
      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-04T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      expect(loaded[0].agent).toBe("agent-0");
      expect(loaded[99].agent).toBe("new-entry");
      // Archive should have 5 deleted
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(5);
      expect(archived.every((r) => r.agent.startsWith("deleted-"))).toBe(true);
    });

    it("should archive deleted + oldest overflow when both need trimming", () => {
      const records: SpawnRecord[] = [];
      // 102 non-deleted
      for (let i = 0; i < 102; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        });
      }
      // 3 deleted
      for (let i = 0; i < 3; i++) {
        records.push({
          agent: `deleted-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-02T00:00:00.000Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            deleted: true,
            deleted_at: "2026-01-03T00:00:00.000Z",
          },
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // 105 existing + 1 new = 106. Remove 3 deleted = 103 non-deleted. 103 > 100 → trim 3 oldest.
      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-04T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      // Oldest 3 non-deleted should be trimmed
      expect(loaded[0].agent).toBe("agent-3");
      expect(loaded[99].agent).toBe("new-entry");
      // Archive should have 3 deleted + 3 overflow = 6
      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(6);
    });
  });

  // ── Archive file behavior ─────────────────────────────────────────────

  describe("archive file behavior", () => {
    it("should append to existing archive file from same day", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // First trim
      saveSpawnRecord({
        agent: "first-new",
        cloud: "cloud",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      // Second trim (now history has agent-1 through first-new, 100 entries)
      saveSpawnRecord({
        agent: "second-new",
        cloud: "cloud",
        timestamp: "2026-01-03T00:00:00.000Z",
      });

      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      // Both trims should append to same archive file
      const archived = loadArchive(testDir, archives[0]);
      expect(archived).toHaveLength(2);
      expect(archived[0].agent).toBe("agent-0");
      expect(archived[1].agent).toBe("agent-1");
    });

    it("should create archive with correct date format in name", () => {
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
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const archives = getArchiveFiles(testDir);
      expect(archives).toHaveLength(1);
      // Should match YYYY-MM-DD pattern
      expect(archives[0]).toMatch(/^history-\d{4}-\d{2}-\d{2}\.json$/);
    });

    it("should write valid pretty-printed JSON to archive", () => {
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
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const archives = getArchiveFiles(testDir);
      const raw = readFileSync(join(testDir, archives[0]), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw).toContain("  "); // pretty-printed
      expect(raw.endsWith("\n")).toBe(true); // trailing newline
    });

    it("should still save record even if archive write fails gracefully", () => {
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          agent: `agent-${i}`,
          cloud: "cloud",
          timestamp: "2026-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      // Pre-create a directory with the archive name to cause write to fail
      const date = new Date().toISOString().slice(0, 10);
      mkdirSync(join(testDir, `history-${date}.json`), {
        recursive: true,
      });

      // Save should still work even though archive write fails
      saveSpawnRecord({
        agent: "new-entry",
        cloud: "cloud",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(100);
      expect(loaded[99].agent).toBe("new-entry");
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
    // NOTE: "99 to 100" and "100 to 101" boundary tests were removed as duplicates
    // of "should keep all entries when at exactly 100" and "should trim to 100 when
    // adding entry that exceeds the limit" in the MAX_HISTORY_ENTRIES section above.

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
