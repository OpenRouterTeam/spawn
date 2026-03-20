import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterHistory, loadHistory, saveSpawnRecord } from "../history.js";

/**
 * Tests for filterHistory ordering and saveSpawnRecord behavior.
 *
 * History has no entry cap — all records are kept indefinitely.
 * These tests verify ordering guarantees and basic save/load behavior.
 */

describe("History Ordering and Save Behavior", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `spawn-history-trim-${Date.now()}-${Math.random()}`);
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

  // ── saveSpawnRecord ──────────────────────────────────────────────────────

  describe("saveSpawnRecord", () => {
    it("should keep all entries with no cap", () => {
      // Save 200 records — all should be retained
      for (let i = 0; i < 200; i++) {
        saveSpawnRecord({
          id: `id-${i}`,
          agent: `agent-${i}`,
          cloud: "hetzner",
          timestamp: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        });
      }
      const loaded = loadHistory();
      expect(loaded).toHaveLength(200);
      expect(loaded[0].agent).toBe("agent-0");
      expect(loaded[199].agent).toBe("agent-199");
    });

    it("should assign id when missing", () => {
      saveSpawnRecord({
        id: "",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(typeof loaded[0].id).toBe("string");
      expect(loaded[0].id.length).toBeGreaterThan(0);
    });
  });

  // ── filterHistory ordering guarantees ────────────────────────────────────

  describe("filterHistory ordering guarantees", () => {
    it("should return records in reverse chronological order (newest first)", () => {
      const records: SpawnRecord[] = [
        {
          id: "r1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "r3",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

      const result = filterHistory();
      expect(result).toHaveLength(3);
      expect(result[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
      expect(result[1].timestamp).toBe("2026-01-02T00:00:00.000Z");
      expect(result[2].timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should maintain reverse order after filtering by agent", () => {
      const records: SpawnRecord[] = [
        {
          id: "r1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "r3",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
        {
          id: "r4",
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
          id: "r1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "r3",
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
          id: "r1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "r3",
          agent: "codex",
          cloud: "sprite",
          timestamp: "2026-01-03T00:00:00.000Z",
        },
        {
          id: "r4",
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
          id: "r1",
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
});
