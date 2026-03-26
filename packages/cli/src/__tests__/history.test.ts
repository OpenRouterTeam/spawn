import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterHistory, HISTORY_SCHEMA_VERSION, loadHistory, saveSpawnRecord } from "../history.js";

describe("history", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Use a directory within home directory for testing (required by security validation)
    testDir = join(process.env.HOME ?? "", `.spawn-test-${Date.now()}-${Math.random()}`);
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

  // ── loadHistory ─────────────────────────────────────────────────────────

  describe("loadHistory", () => {
    it("returns empty array when history file does not exist", () => {
      expect(loadHistory()).toEqual([]);
    });

    it("loads valid history from file", () => {
      const records = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("claude");
      expect(loaded[0].cloud).toBe("sprite");
      // Legacy records without id get one backfilled on load
      expect(typeof loaded[0].id).toBe("string");
    });

    it("returns empty array for invalid JSON", () => {
      writeFileSync(join(testDir, "history.json"), "not json at all{{{");
      expect(loadHistory()).toEqual([]);
    });

    it("returns empty array when file contains an unrecognized JSON value", () => {
      // All non-array, non-v1 JSON values hit the same "Unrecognized format" branch
      for (const content of [
        JSON.stringify({
          not: "array",
        }),
        JSON.stringify("just a string"),
        "null",
        "42",
      ]) {
        writeFileSync(join(testDir, "history.json"), content);
        expect(loadHistory()).toEqual([]);
      }
    });

    it("loads multiple records preserving order", () => {
      const records = [
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
      const loaded = loadHistory();
      expect(loaded).toHaveLength(3);
      expect(loaded[0].agent).toBe("claude");
      expect(loaded[1].agent).toBe("codex");
      expect(loaded[2].agent).toBe("claude");
      expect(loaded[2].cloud).toBe("hetzner");
    });

    it("loads records that include optional prompt field", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
          prompt: "Fix bugs",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].prompt).toBe("Fix bugs");
    });

    it("returns empty array for empty file", () => {
      writeFileSync(join(testDir, "history.json"), "");
      expect(loadHistory()).toEqual([]);
    });

    it("loads v1 format: { version: 1, records: [...] }", () => {
      const records = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("claude");
      expect(typeof loaded[0].id).toBe("string");
    });

    it("returns empty array for v1 format with unknown version", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 99,
          records,
        }),
      );
      // Unknown version is not a recognized format; treated as invalid non-array
      expect(loadHistory()).toEqual([]);
    });

    it("loads v0 format: bare array (backward compatibility)", () => {
      const records = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("claude");
      // v0 records get id backfilled
      expect(typeof loaded[0].id).toBe("string");
    });
  });

  // ── saveSpawnRecord ─────────────────────────────────────────────────────

  describe("saveSpawnRecord", () => {
    it("creates directory and file when neither exist", () => {
      const nestedDir = join(process.env.HOME ?? "", ".spawn-test", "nested", "spawn");
      process.env.SPAWN_HOME = nestedDir;

      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      expect(existsSync(join(nestedDir, "history.json"))).toBe(true);
      const data = JSON.parse(readFileSync(join(nestedDir, "history.json"), "utf-8"));
      expect(data.version).toBe(HISTORY_SCHEMA_VERSION);
      expect(data.records).toHaveLength(1);
      expect(data.records[0].agent).toBe("claude");

      // Clean up
      rmSync(join(process.env.HOME ?? "", ".spawn-test"), {
        recursive: true,
        force: true,
      });
    });

    it("appends to existing history", () => {
      const existing: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(existing));

      saveSpawnRecord({
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.version).toBe(HISTORY_SCHEMA_VERSION);
      expect(data.records).toHaveLength(2);
      expect(data.records[0].agent).toBe("claude");
      expect(data.records[1].agent).toBe("codex");
    });

    it("saves record with prompt field", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
        prompt: "Fix all linter errors",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].prompt).toBe("Fix all linter errors");
    });

    it("saves record without prompt field", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].prompt).toBeUndefined();
    });

    it("writes pretty-printed JSON with trailing newline", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const raw = readFileSync(join(testDir, "history.json"), "utf-8");
      expect(raw).toContain("\n");
      expect(raw.endsWith("\n")).toBe(true);
      // Pretty-printed JSON has indentation
      expect(raw).toContain("  ");
    });

    it("handles multiple sequential saves", () => {
      for (let i = 0; i < 5; i++) {
        saveSpawnRecord({
          agent: `agent-${i}`,
          cloud: `cloud-${i}`,
          timestamp: `2026-01-0${i + 1}T00:00:00.000Z`,
        });
      }

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.version).toBe(HISTORY_SCHEMA_VERSION);
      expect(data.records).toHaveLength(5);
      expect(data.records[0].agent).toBe("agent-0");
      expect(data.records[4].agent).toBe("agent-4");
    });

    it("writes v1 format with version and records fields", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.version).toBe(HISTORY_SCHEMA_VERSION);
      expect(Array.isArray(data.records)).toBe(true);
    });

    it("migrates v0 bare array to v1 format on next save", () => {
      const existing: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      // Write v0 bare array
      writeFileSync(join(testDir, "history.json"), JSON.stringify(existing));

      // Trigger a write via saveSpawnRecord
      saveSpawnRecord({
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-01-02T00:00:00.000Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.version).toBe(HISTORY_SCHEMA_VERSION);
      expect(data.records).toHaveLength(2);
      expect(data.records[0].agent).toBe("claude");
      expect(data.records[1].agent).toBe("codex");
    });

    it("keeps all entries with no cap", () => {
      // Save 200 records — all should be retained (history has no entry limit)
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

    it("assigns id when missing", () => {
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

    // Corruption recovery and backup tests are in history-corruption.test.ts
  });

  // ── filterHistory ───────────────────────────────────────────────────────

  describe("filterHistory", () => {
    const sampleRecords: SpawnRecord[] = [
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
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-05T00:00:00.000Z",
        prompt: "Test",
      },
    ];

    beforeEach(() => {
      writeFileSync(join(testDir, "history.json"), JSON.stringify(sampleRecords));
    });

    it("returns all records with no filters", () => {
      expect(filterHistory()).toHaveLength(5);
    });

    it("filters by agent name", () => {
      const results = filterHistory("claude");
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.agent).toBe("claude");
      }
    });

    it("filters by cloud name", () => {
      const results = filterHistory(undefined, "sprite");
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.cloud).toBe("sprite");
      }
    });

    it("filters by both agent and cloud", () => {
      const results = filterHistory("claude", "sprite");
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.agent).toBe("claude");
        expect(r.cloud).toBe("sprite");
      }
    });

    it("is case-insensitive for agent filter", () => {
      const results = filterHistory("CLAUDE");
      expect(results).toHaveLength(3);
    });

    it("is case-insensitive for cloud filter", () => {
      const results = filterHistory(undefined, "HETZNER");
      expect(results).toHaveLength(2);
    });

    it("is case-insensitive for both filters", () => {
      const results = filterHistory("CODEX", "SPRITE");
      expect(results).toHaveLength(1);
      expect(results[0].agent).toBe("codex");
      expect(results[0].cloud).toBe("sprite");
    });

    it("returns empty array when agent filter matches nothing", () => {
      const results = filterHistory("nonexistent");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when cloud filter matches nothing", () => {
      const results = filterHistory(undefined, "nonexistent");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when combined filters match nothing", () => {
      const results = filterHistory("claude", "nonexistent");
      expect(results).toHaveLength(0);
    });

    it("returns empty array when history file is missing", () => {
      rmSync(join(testDir, "history.json"));
      expect(filterHistory()).toHaveLength(0);
    });

    it("handles undefined agent filter as no agent filter", () => {
      const all = filterHistory(undefined, undefined);
      expect(all).toHaveLength(5);
    });
  });

  describe("timestamp round-trip", () => {
    // timestamp handling tested indirectly through loadHistory round-trip
    it("preserves ISO timestamp strings through save/load cycle", () => {
      const ts = "2026-02-11T14:30:00.000Z";
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: ts,
      });
      const loaded = loadHistory();
      expect(loaded[0].timestamp).toBe(ts);
    });

    it("preserves non-ISO timestamp strings through save/load cycle", () => {
      const ts = "not-a-date";
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: ts,
      });
      const loaded = loadHistory();
      expect(loaded[0].timestamp).toBe("not-a-date");
    });
  });

  // ── Lock recovery ───────────────────────────────────────────────────────

  describe("lock recovery", () => {
    it("recovers from a broken lock directory with no PID file", () => {
      // Simulate a crashed process that left a lock dir without a PID file
      const lockPath = join(testDir, "history.json.lock");
      mkdirSync(lockPath, {
        recursive: true,
      });
      // No pid file inside — this is the broken state

      // saveSpawnRecord uses withLock internally — should clean up the broken lock and succeed
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("claude");
      // Lock dir should be cleaned up
      expect(existsSync(lockPath)).toBe(false);
    });

    it("recovers from a stale lock with expired PID file", () => {
      // Simulate a lock left by a process that died long ago
      const lockPath = join(testDir, "history.json.lock");
      mkdirSync(lockPath, {
        recursive: true,
      });
      // Write a PID file with a timestamp far in the past (> 30s stale threshold)
      writeFileSync(join(lockPath, "pid"), `99999\n${Date.now() - 60_000}`);

      saveSpawnRecord({
        agent: "codex",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
      });

      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].agent).toBe("codex");
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
