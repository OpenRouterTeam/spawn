/**
 * history-spawn-id.test.ts — Tests for unique spawn ID behavior.
 *
 * Verifies that:
 * - Every saved record gets a unique id
 * - saveLaunchCmd matches by spawnId (not heuristic)
 * - removeRecord / markRecordDeleted match by id
 * - Concurrent spawns on the same cloud don't cross-contaminate
 * - Backward compat: records without id still work via heuristic
 */

import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateSpawnId,
  getHistoryPath,
  loadHistory,
  markRecordDeleted,
  removeRecord,
  saveLaunchCmd,
  saveSpawnRecord,
} from "../history.js";

describe("history spawn IDs", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
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

  // ── generateSpawnId ──────────────────────────────────────────────────

  describe("generateSpawnId", () => {
    it("returns a valid UUID string", () => {
      const id = generateSpawnId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("returns unique values on each call", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateSpawnId());
      }
      expect(ids.size).toBe(100);
    });
  });

  // ── saveSpawnRecord auto-generates id ────────────────────────────────

  describe("saveSpawnRecord id generation", () => {
    it("auto-generates id when not provided", () => {
      saveSpawnRecord({
        id: "",
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const history = loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBeDefined();
      expect(typeof history[0].id).toBe("string");
      expect(history[0].id.length).toBeGreaterThan(0);
    });

    it("preserves id when explicitly provided", () => {
      const customId = "custom-id-123";
      saveSpawnRecord({
        id: customId,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const history = loadHistory();
      expect(history[0].id).toBe(customId);
    });

    it("generates different ids for consecutive saves", () => {
      saveSpawnRecord({
        id: "",
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      saveSpawnRecord({
        id: "",
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:01:00.000Z",
      });

      const history = loadHistory();
      expect(history).toHaveLength(2);
      expect(history[0].id).not.toBe(history[1].id);
    });

    it("saves connection data atomically with the record", () => {
      const id = generateSpawnId();
      saveSpawnRecord({
        id,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
        connection: {
          ip: "1.2.3.4",
          user: "root",
          server_name: "my-server",
          cloud: "gcp",
        },
      });

      const history = loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].connection?.ip).toBe("1.2.3.4");
      expect(history[0].connection?.server_name).toBe("my-server");
      expect(history[0].connection?.cloud).toBe("gcp");
    });
  });

  // ── saveLaunchCmd matches by spawnId ──────────────────────────────────

  describe("saveLaunchCmd with spawnId", () => {
    it("updates the correct record by spawnId", () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();

      saveSpawnRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
        connection: {
          ip: "1.1.1.1",
          user: "root",
          server_name: "srv1",
          cloud: "gcp",
        },
      });
      saveSpawnRecord({
        id: id2,
        agent: "codex",
        cloud: "gcp",
        timestamp: "2026-01-01T00:01:00.000Z",
        connection: {
          ip: "2.2.2.2",
          user: "root",
          server_name: "srv2",
          cloud: "gcp",
        },
      });

      // Update launch command for the FIRST record only
      saveLaunchCmd("claude --start", id1);

      const history = loadHistory();
      expect(history[0].connection?.launch_cmd).toBe("claude --start");
      expect(history[1].connection?.launch_cmd).toBeUndefined();
    });

    it("falls back to most recent record with connection when no spawnId", () => {
      const id = generateSpawnId();
      saveSpawnRecord({
        id,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
        connection: {
          ip: "1.1.1.1",
          user: "root",
          server_name: "srv",
          cloud: "gcp",
        },
      });

      saveLaunchCmd("fallback-cmd");

      const history = loadHistory();
      expect(history[0].connection?.launch_cmd).toBe("fallback-cmd");
    });
  });

  // ── removeRecord matches by id ────────────────────────────────────────

  describe("removeRecord with id", () => {
    it("removes the correct record by id", () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();

      saveSpawnRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      saveSpawnRecord({
        id: id2,
        agent: "codex",
        cloud: "gcp",
        timestamp: "2026-01-01T00:01:00.000Z",
      });

      const result = removeRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result).toBe(true);

      const history = loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(id2);
    });

    it("does not remove wrong record with same agent/cloud/timestamp", () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();
      const ts = "2026-01-01T00:00:00.000Z";

      // Two records with same agent/cloud/timestamp but different ids
      saveSpawnRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: ts,
      });
      saveSpawnRecord({
        id: id2,
        agent: "claude",
        cloud: "gcp",
        timestamp: ts,
      });

      // Remove by id1 — should only remove the first one
      removeRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: ts,
      });

      const history = loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(id2);
    });

    it("falls back to timestamp+agent+cloud for records without id", () => {
      // Write a legacy record without id directly
      const legacy: SpawnRecord[] = [
        {
          id: "",
          agent: "claude",
          cloud: "gcp",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00.000Z",
        },
      ];
      writeFileSync(getHistoryPath(), JSON.stringify(legacy, null, 2) + "\n");

      const result = removeRecord({
        id: "",
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result).toBe(true);

      const history = loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].agent).toBe("codex");
    });
  });

  // ── markRecordDeleted matches by id ───────────────────────────────────

  describe("markRecordDeleted with id", () => {
    it("marks the correct record as deleted by id", () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();

      saveSpawnRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
        connection: {
          ip: "1.1.1.1",
          user: "root",
          server_id: "srv1",
          server_name: "server1",
          cloud: "gcp",
        },
      });
      saveSpawnRecord({
        id: id2,
        agent: "codex",
        cloud: "gcp",
        timestamp: "2026-01-01T00:01:00.000Z",
        connection: {
          ip: "2.2.2.2",
          user: "root",
          server_id: "srv2",
          server_name: "server2",
          cloud: "gcp",
        },
      });

      // Mark only the first as deleted
      const result = markRecordDeleted({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result).toBe(true);

      const history = loadHistory();
      expect(history[0].connection?.deleted).toBe(true);
      expect(history[0].connection?.deleted_at).toBeDefined();
      expect(history[1].connection?.deleted).toBeUndefined();
    });

    it("returns false when record has no connection", () => {
      const id = generateSpawnId();
      saveSpawnRecord({
        id,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      const result = markRecordDeleted({
        id,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result).toBe(false);
    });
  });
});
