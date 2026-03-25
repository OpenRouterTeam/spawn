import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  // ── Tree building ────────────────────────────────────────────────────

  describe("tree command", () => {
    it("builds tree structure from records with parent_id", async () => {
      // Save a parent and two children
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

      const loaded = loadHistory();
      expect(loaded).toHaveLength(4);

      // Verify parent-child relationships
      const root = loaded.find((r) => r.id === "root-1");
      expect(root).toBeDefined();
      expect(root!.parent_id).toBeUndefined();

      const child1 = loaded.find((r) => r.id === "child-1");
      expect(child1!.parent_id).toBe("root-1");

      const grandchild = loaded.find((r) => r.id === "grandchild-1");
      expect(grandchild!.parent_id).toBe("child-1");
      expect(grandchild!.depth).toBe(2);
    });
  });

  // ── List tree rendering ──────────────────────────────────────────────

  describe("list with tree structure", () => {
    it("detects tree structure in records", async () => {
      const recordsWithTree: SpawnRecord[] = [
        {
          id: "root",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "child",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-03-24T01:00:00.000Z",
          parent_id: "root",
        },
      ];

      const hasTree = recordsWithTree.some((r) => r.parent_id);
      expect(hasTree).toBe(true);

      const recordsFlat: SpawnRecord[] = [
        {
          id: "a",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-03-24T00:00:00.000Z",
        },
        {
          id: "b",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-03-24T01:00:00.000Z",
        },
      ];

      const hasTreeFlat = recordsFlat.some((r) => r.parent_id);
      expect(hasTreeFlat).toBe(false);
    });
  });
});
