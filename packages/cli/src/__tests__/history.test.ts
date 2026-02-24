import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpawnRecord } from "../history.js";
import { getSpawnDir, getHistoryPath, loadHistory, saveSpawnRecord, filterHistory } from "../history.js";

describe("history", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Use a directory within home directory for testing (required by security validation)
    testDir = join(homedir(), `.spawn-test-${Date.now()}-${Math.random()}`);
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

  // ── getSpawnDir ─────────────────────────────────────────────────────────

  describe("getSpawnDir", () => {
    it("returns SPAWN_HOME when set to valid path within home", () => {
      const validPath = join(homedir(), "custom", "spawn", "dir");
      process.env.SPAWN_HOME = validPath;
      expect(getSpawnDir()).toBe(validPath);
    });

    it("falls back to ~/.spawn when SPAWN_HOME is not set", () => {
      delete process.env.SPAWN_HOME;
      expect(getSpawnDir()).toBe(join(homedir(), ".spawn"));
    });

    it("throws for relative SPAWN_HOME path", () => {
      process.env.SPAWN_HOME = "relative/path";
      expect(() => getSpawnDir()).toThrow("must be an absolute path");
    });

    it("throws for dot-relative SPAWN_HOME path", () => {
      process.env.SPAWN_HOME = "./local/dir";
      expect(() => getSpawnDir()).toThrow("must be an absolute path");
    });

    it("resolves .. segments in absolute SPAWN_HOME within home", () => {
      const pathWithDots = join(homedir(), "foo", "..", "bar");
      process.env.SPAWN_HOME = pathWithDots;
      expect(getSpawnDir()).toBe(join(homedir(), "bar"));
    });

    it("accepts normal absolute SPAWN_HOME within home", () => {
      const validPath = join(homedir(), ".spawn");
      process.env.SPAWN_HOME = validPath;
      expect(getSpawnDir()).toBe(validPath);
    });

    it("throws for SPAWN_HOME outside home directory", () => {
      process.env.SPAWN_HOME = "/tmp/spawn";
      expect(() => getSpawnDir()).toThrow("must be within your home directory");
    });

    it("throws for SPAWN_HOME pointing to /root when user home is different", () => {
      // Only run this test if we're not actually running as root
      if (homedir() !== "/root") {
        process.env.SPAWN_HOME = "/root/.spawn";
        expect(() => getSpawnDir()).toThrow("must be within your home directory");
      }
    });

    it("throws for path traversal attempt to escape home directory", () => {
      // Attempt to traverse outside home using .. segments
      // e.g., /home/user/../../etc/.spawn
      const traversalPath = join(homedir(), "..", "..", "etc", ".spawn");
      process.env.SPAWN_HOME = traversalPath;
      expect(() => getSpawnDir()).toThrow("must be within your home directory");
    });

    it("accepts home directory itself as SPAWN_HOME", () => {
      process.env.SPAWN_HOME = homedir();
      expect(getSpawnDir()).toBe(homedir());
    });
  });

  // ── getHistoryPath ──────────────────────────────────────────────────────

  describe("getHistoryPath", () => {
    it("returns history.json inside spawn dir", () => {
      expect(getHistoryPath()).toBe(join(testDir, "history.json"));
    });
  });

  // ── loadHistory ─────────────────────────────────────────────────────────

  describe("loadHistory", () => {
    it("returns empty array when history file does not exist", () => {
      expect(loadHistory()).toEqual([]);
    });

    it("loads valid history from file", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
      expect(loadHistory()).toEqual(records);
    });

    it("returns empty array for invalid JSON", () => {
      writeFileSync(join(testDir, "history.json"), "not json at all{{{");
      expect(loadHistory()).toEqual([]);
    });

    it("returns empty array when file contains a non-array JSON value", () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          not: "array",
        }),
      );
      expect(loadHistory()).toEqual([]);
    });

    it("returns empty array when file contains a JSON string", () => {
      writeFileSync(join(testDir, "history.json"), JSON.stringify("just a string"));
      expect(loadHistory()).toEqual([]);
    });

    it("returns empty array when file contains JSON null", () => {
      writeFileSync(join(testDir, "history.json"), "null");
      expect(loadHistory()).toEqual([]);
    });

    it("returns empty array when file contains JSON number", () => {
      writeFileSync(join(testDir, "history.json"), "42");
      expect(loadHistory()).toEqual([]);
    });

    it("loads multiple records preserving order", () => {
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
      expect(loadHistory()).toEqual(records);
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
  });

  // ── saveSpawnRecord ─────────────────────────────────────────────────────

  describe("saveSpawnRecord", () => {
    it("creates directory and file when neither exist", () => {
      const nestedDir = join(homedir(), ".spawn-test", "nested", "spawn");
      process.env.SPAWN_HOME = nestedDir;

      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      expect(existsSync(join(nestedDir, "history.json"))).toBe(true);
      const data = JSON.parse(readFileSync(join(nestedDir, "history.json"), "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].agent).toBe("claude");

      // Clean up
      rmSync(join(homedir(), ".spawn-test"), {
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
      expect(data).toHaveLength(2);
      expect(data[0].agent).toBe("claude");
      expect(data[1].agent).toBe("codex");
    });

    it("saves record with prompt field", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
        prompt: "Fix all linter errors",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data[0].prompt).toBe("Fix all linter errors");
    });

    it("saves record without prompt field", () => {
      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data[0].prompt).toBeUndefined();
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
      expect(data).toHaveLength(5);
      expect(data[0].agent).toBe("agent-0");
      expect(data[4].agent).toBe("agent-4");
    });

    it("recovers from corrupted existing history file", () => {
      writeFileSync(join(testDir, "history.json"), "corrupted{{{");

      saveSpawnRecord({
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      // loadHistory returns [] for corrupted files, so saveSpawnRecord starts fresh
      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].agent).toBe("claude");
    });
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

  // ── formatTimestamp (imported via commands.ts, tested inline) ──────────

  describe("formatTimestamp edge cases (via cmdList integration)", () => {
    // formatTimestamp is not exported from history.ts, but we test the
    // timestamp handling indirectly through loadHistory round-trip
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
});
