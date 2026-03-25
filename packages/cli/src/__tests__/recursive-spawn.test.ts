import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdTree } from "../commands/tree.js";
import { exportHistory, HISTORY_SCHEMA_VERSION, loadHistory, mergeChildHistory, saveSpawnRecord } from "../history.js";

describe("recursive spawn", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `.spawn-test-recursive-${Date.now()}-${Math.random()}`);
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

  // ── SpawnRecord parent_id and depth ─────────────────────────────────────

  describe("parent tracking", () => {
    it("saves and loads records with parent_id and depth", () => {
      const record: SpawnRecord = {
        id: "child-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
        parent_id: "parent-1",
        depth: 1,
      };
      saveSpawnRecord(record);
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].parent_id).toBe("parent-1");
      expect(loaded[0].depth).toBe(1);
    });

    it("loads records without parent_id (backwards compat)", () => {
      const data = {
        version: HISTORY_SCHEMA_VERSION,
        records: [
          {
            id: "old-record",
            agent: "claude",
            cloud: "hetzner",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      writeFileSync(join(testDir, "history.json"), JSON.stringify(data));
      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].parent_id).toBeUndefined();
      expect(loaded[0].depth).toBeUndefined();
    });
  });

  // ── mergeChildHistory ──────────────────────────────────────────────────

  describe("mergeChildHistory", () => {
    it("merges child records into local history", () => {
      // Save a parent record first
      saveSpawnRecord({
        id: "parent-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
      });

      const childRecords: SpawnRecord[] = [
        {
          id: "child-1",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-03-24T01:00:00.000Z",
        },
        {
          id: "child-2",
          agent: "openclaw",
          cloud: "hetzner",
          timestamp: "2026-03-24T02:00:00.000Z",
        },
      ];

      mergeChildHistory("parent-1", childRecords);

      const loaded = loadHistory();
      expect(loaded).toHaveLength(3);

      // Child records should have parent_id set
      const child1 = loaded.find((r) => r.id === "child-1");
      expect(child1).toBeDefined();
      expect(child1!.parent_id).toBe("parent-1");

      const child2 = loaded.find((r) => r.id === "child-2");
      expect(child2).toBeDefined();
      expect(child2!.parent_id).toBe("parent-1");
    });

    it("deduplicates by spawn ID", () => {
      saveSpawnRecord({
        id: "parent-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
      });

      const childRecords: SpawnRecord[] = [
        {
          id: "child-1",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-03-24T01:00:00.000Z",
        },
      ];

      // Merge twice — should not create duplicates
      mergeChildHistory("parent-1", childRecords);
      mergeChildHistory("parent-1", childRecords);

      const loaded = loadHistory();
      expect(loaded).toHaveLength(2); // parent + 1 child (not 3)
    });

    it("preserves existing parent_id on child records", () => {
      saveSpawnRecord({
        id: "grandparent",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
      });

      const childRecords: SpawnRecord[] = [
        {
          id: "child-1",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-03-24T01:00:00.000Z",
          parent_id: "some-other-parent",
        },
      ];

      mergeChildHistory("grandparent", childRecords);

      const loaded = loadHistory();
      const child = loaded.find((r) => r.id === "child-1");
      // Existing parent_id should be preserved
      expect(child!.parent_id).toBe("some-other-parent");
    });

    it("does nothing with empty child records", () => {
      saveSpawnRecord({
        id: "parent-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
      });

      mergeChildHistory("parent-1", []);

      const loaded = loadHistory();
      expect(loaded).toHaveLength(1);
    });
  });

  // ── exportHistory ─────────────────────────────────────────────────────

  describe("exportHistory", () => {
    it("exports history as JSON string", () => {
      saveSpawnRecord({
        id: "record-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
        parent_id: "parent-1",
        depth: 1,
      });

      const json = exportHistory();
      const parsed: unknown = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      const records = Array.isArray(parsed) ? parsed : [];
      expect(records).toHaveLength(1);
      expect(records[0].parent_id).toBe("parent-1");
      expect(records[0].depth).toBe(1);
    });

    it("returns empty array when no history", () => {
      const json = exportHistory();
      expect(JSON.parse(json)).toEqual([]);
    });
  });

  // ── Recursive env vars ───────────────────────────────────────────────

  describe("recursive env vars", () => {
    it("appendRecursiveEnvVars adds parent tracking vars", async () => {
      // Import the function dynamically to avoid ESM issues
      const { appendRecursiveEnvVars } = await import("../shared/orchestrate.js");
      const envPairs: string[] = [
        "EXISTING_VAR=value",
      ];

      appendRecursiveEnvVars(envPairs, "test-spawn-id");

      expect(envPairs).toContain("SPAWN_PARENT_ID=test-spawn-id");
      expect(envPairs).toContain("SPAWN_DEPTH=1");
      expect(envPairs).toContain("SPAWN_BETA=recursive");
    });

    it("increments depth from SPAWN_DEPTH env var", async () => {
      const origDepth = process.env.SPAWN_DEPTH;
      process.env.SPAWN_DEPTH = "3";

      const { appendRecursiveEnvVars } = await import("../shared/orchestrate.js");
      const envPairs: string[] = [];
      appendRecursiveEnvVars(envPairs, "test-id");

      expect(envPairs).toContain("SPAWN_DEPTH=4");

      if (origDepth === undefined) {
        delete process.env.SPAWN_DEPTH;
      } else {
        process.env.SPAWN_DEPTH = origDepth;
      }
    });
  });

  // ── cmdTree ────────────────────────────────────────────────────────

  describe("cmdTree", () => {
    it("shows empty message when no history", async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      await cmdTree();

      console.log = origLog;
      // p.log.info writes to stderr, not captured — but cmdTree should not throw
    });

    it("renders tree with parent-child relationships", async () => {
      saveSpawnRecord({
        id: "root-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
        name: "my-root",
      });
      saveSpawnRecord({
        id: "child-1",
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-03-24T01:00:00.000Z",
        parent_id: "root-1",
        depth: 1,
        name: "my-child",
      });
      saveSpawnRecord({
        id: "child-2",
        agent: "openclaw",
        cloud: "hetzner",
        timestamp: "2026-03-24T02:00:00.000Z",
        parent_id: "root-1",
        depth: 1,
      });
      saveSpawnRecord({
        id: "grandchild-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T03:00:00.000Z",
        parent_id: "child-1",
        depth: 2,
      });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      // Mock loadManifest to avoid network calls
      const manifestMod = await import("../manifest.js");
      const manifestSpy = spyOn(manifestMod, "loadManifest").mockRejectedValue(new Error("no network"));

      await cmdTree();

      console.log = origLog;
      manifestSpy.mockRestore();

      // Should have output with tree characters
      const output = logs.join("\n");
      expect(output).toContain("my-root");
      expect(output).toContain("my-child");
      // Tree connectors
      expect(output).toContain("├─");
      expect(output).toContain("└─");
    });

    it("outputs JSON when --json flag is set", async () => {
      saveSpawnRecord({
        id: "root-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
      });
      saveSpawnRecord({
        id: "child-1",
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-03-24T01:00:00.000Z",
        parent_id: "root-1",
        depth: 1,
      });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      const manifestMod = await import("../manifest.js");
      const manifestSpy = spyOn(manifestMod, "loadManifest").mockRejectedValue(new Error("no network"));

      await cmdTree(true);

      console.log = origLog;
      manifestSpy.mockRestore();

      const output = logs.join("\n");
      const parsed: unknown = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      const records = Array.isArray(parsed) ? parsed : [];
      expect(records).toHaveLength(2);
    });

    it("shows flat message when no parent-child relationships", async () => {
      saveSpawnRecord({
        id: "a",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
      });
      saveSpawnRecord({
        id: "b",
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-03-24T01:00:00.000Z",
      });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      const manifestMod = await import("../manifest.js");
      const manifestSpy = spyOn(manifestMod, "loadManifest").mockRejectedValue(new Error("no network"));

      await cmdTree();

      console.log = origLog;
      manifestSpy.mockRestore();
    });

    it("renders deleted and depth labels", async () => {
      saveSpawnRecord({
        id: "root-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-24T00:00:00.000Z",
        connection: {
          ip: "1.2.3.4",
          user: "root",
          deleted: true,
          deleted_at: "2026-03-24T05:00:00.000Z",
        },
      });
      saveSpawnRecord({
        id: "child-1",
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-03-24T01:00:00.000Z",
        parent_id: "root-1",
        depth: 1,
      });

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };

      const manifestMod = await import("../manifest.js");
      const manifestSpy = spyOn(manifestMod, "loadManifest").mockRejectedValue(new Error("no network"));

      await cmdTree();

      console.log = origLog;
      manifestSpy.mockRestore();

      const output = logs.join("\n");
      expect(output).toContain("deleted");
      expect(output).toContain("depth=1");
    });
  });
});
