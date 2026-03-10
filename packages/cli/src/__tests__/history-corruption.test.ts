import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistory, saveSpawnRecord } from "../history.js";

describe("history corruption recovery", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `.spawn-test-corrupt-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    originalEnv = {
      ...process.env,
    };
    process.env.SPAWN_HOME = testDir;
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    }
  });

  // ── Atomic writes ──────────────────────────────────────────────────────

  describe("atomic writes", () => {
    it("does not leave .tmp file behind after save", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(existsSync(join(testDir, "history.json"))).toBe(true);
      expect(existsSync(join(testDir, "history.json.tmp"))).toBe(false);
    });
  });

  // ── Corruption backup ─────────────────────────────────────────────────

  describe("corruption backup", () => {
    it("creates .corrupt backup for corrupted JSON", () => {
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");
      loadHistory();
      const files = readdirSync(testDir);
      const backups = files.filter((f) => f.startsWith("history.json.corrupt."));
      expect(backups.length).toBe(1);
    });

    it("creates .corrupt backup for unrecognized format", () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 99,
          records: [],
        }),
      );
      loadHistory();
      const files = readdirSync(testDir);
      const backups = files.filter((f) => f.startsWith("history.json.corrupt."));
      expect(backups.length).toBe(1);
    });

    it("does NOT create .corrupt backup for empty file", () => {
      writeFileSync(join(testDir, "history.json"), "");
      loadHistory();
      const files = readdirSync(testDir);
      const backups = files.filter((f) => f.startsWith("history.json.corrupt."));
      expect(backups.length).toBe(0);
    });

    it("does NOT create .corrupt backup for missing file", () => {
      loadHistory();
      const files = existsSync(testDir) ? readdirSync(testDir) : [];
      const backups = files.filter((f) => f.startsWith("history.json.corrupt."));
      expect(backups.length).toBe(0);
    });

    it("preserves corrupted file content in backup", () => {
      const corruptedContent = "corrupted{{{partial json";
      writeFileSync(join(testDir, "history.json"), corruptedContent);
      loadHistory();
      const files = readdirSync(testDir);
      const backup = files.find((f) => f.startsWith("history.json.corrupt."));
      expect(backup).toBeDefined();
      const backupContent = readFileSync(join(testDir, backup!), "utf-8");
      expect(backupContent).toBe(corruptedContent);
    });
  });

  // ── Archive recovery ──────────────────────────────────────────────────

  describe("archive recovery", () => {
    it("recovers from most recent valid archive", () => {
      const archiveRecords: SpawnRecord[] = [
        {
          id: "archived-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history-2026-01-15.json"), JSON.stringify(archiveRecords));
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      const result = loadHistory();
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("claude");
    });

    it("picks most recent archive when multiple exist", () => {
      const oldRecords: SpawnRecord[] = [
        {
          id: "old-1",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      const newRecords: SpawnRecord[] = [
        {
          id: "new-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-10T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history-2026-01-05.json"), JSON.stringify(oldRecords));
      writeFileSync(join(testDir, "history-2026-01-15.json"), JSON.stringify(newRecords));
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      const result = loadHistory();
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("claude");
    });

    it("skips corrupted archives and falls back to older ones", () => {
      const goodRecords: SpawnRecord[] = [
        {
          id: "good-1",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history-2026-01-05.json"), JSON.stringify(goodRecords));
      writeFileSync(join(testDir, "history-2026-01-15.json"), "also corrupted{{{");
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      const result = loadHistory();
      expect(result).toHaveLength(1);
      expect(result[0].agent).toBe("codex");
    });

    it("returns empty array when all archives are also corrupted", () => {
      writeFileSync(join(testDir, "history-2026-01-05.json"), "bad{{{");
      writeFileSync(join(testDir, "history-2026-01-15.json"), "also bad{{{");
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      const result = loadHistory();
      expect(result).toEqual([]);
    });

    it("returns empty array when no archives exist", () => {
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      const result = loadHistory();
      expect(result).toEqual([]);
    });
  });

  // ── Per-record salvaging ──────────────────────────────────────────────

  describe("v1 per-record salvaging", () => {
    it("salvages valid records when some are malformed", () => {
      const mixed = {
        version: 1,
        records: [
          {
            agent: "claude",
            cloud: "sprite",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
          {
            bad: "record",
            missing: "required fields",
          },
          {
            agent: "codex",
            cloud: "hetzner",
            timestamp: "2026-01-02T00:00:00.000Z",
          },
        ],
      };
      writeFileSync(join(testDir, "history.json"), JSON.stringify(mixed));
      const result = loadHistory();
      expect(result).toHaveLength(2);
      expect(result[0].agent).toBe("claude");
      expect(result[1].agent).toBe("codex");
    });

    it("returns empty array for v1 with all invalid records", () => {
      const allBad = {
        version: 1,
        records: [
          {
            bad: "record",
          },
          {
            also: "bad",
          },
        ],
      };
      writeFileSync(join(testDir, "history.json"), JSON.stringify(allBad));
      const result = loadHistory();
      expect(result).toEqual([]);
    });

    it("returns empty array for v1 with empty records array without corruption path", () => {
      const empty = {
        version: 1,
        records: [],
      };
      writeFileSync(join(testDir, "history.json"), JSON.stringify(empty));
      const result = loadHistory();
      expect(result).toEqual([]);
      // Should NOT have created any .corrupt backup
      const files = readdirSync(testDir);
      const backups = files.filter((f) => f.startsWith("history.json.corrupt."));
      expect(backups.length).toBe(0);
    });

    it("warns about dropped records to stderr", () => {
      const mixed = {
        version: 1,
        records: [
          {
            agent: "claude",
            cloud: "sprite",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
          {
            bad: "record",
          },
        ],
      };
      writeFileSync(join(testDir, "history.json"), JSON.stringify(mixed));
      loadHistory();
      const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((w) => w.includes("Dropped 1 malformed record"))).toBe(true);
    });
  });

  // ── Save after corruption ─────────────────────────────────────────────

  describe("save after corruption", () => {
    it("preserves recovered records alongside new record", () => {
      const archiveRecords: SpawnRecord[] = [
        {
          id: "archived-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history-2026-01-15.json"), JSON.stringify(archiveRecords));
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      saveSpawnRecord({
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-01-20T00:00:00.000Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records).toHaveLength(2);
      expect(data.records[0].agent).toBe("claude");
      expect(data.records[1].agent).toBe("codex");
    });
  });

  // ── Stderr warnings ──────────────────────────────────────────────────

  describe("stderr warnings", () => {
    it("warns on corrupted JSON", () => {
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");
      loadHistory();
      const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((w) => w.includes("corrupted"))).toBe(true);
    });

    it("warns on archive recovery", () => {
      const archiveRecords: SpawnRecord[] = [
        {
          id: "a1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history-2026-01-15.json"), JSON.stringify(archiveRecords));
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");
      loadHistory();
      const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((w) => w.includes("Recovered"))).toBe(true);
    });
  });
});
