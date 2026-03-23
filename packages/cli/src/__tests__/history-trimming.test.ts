import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterHistory } from "../history.js";

/**
 * Tests for filterHistory ordering guarantees.
 * (saveSpawnRecord tests are in history.test.ts)
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
