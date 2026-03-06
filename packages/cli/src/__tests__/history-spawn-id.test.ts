/**
 * history-spawn-id.test.ts — Tests for unique spawn ID behavior.
 *
 * Verifies that:
 * - Every saved record gets a unique id
 * - saveVmConnection matches by spawnId (not heuristic)
 * - saveLaunchCmd matches by spawnId (not heuristic)
 * - removeRecord / markRecordDeleted match by id
 * - Concurrent spawns on the same cloud don't cross-contaminate
 * - Backward compat: records without id still work via heuristic
 */

import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateSpawnId,
  getActiveServers,
  getConnectionPath,
  getHistoryPath,
  loadHistory,
  markRecordDeleted,
  removeRecord,
  saveLaunchCmd,
  saveSpawnRecord,
  saveVmConnection,
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
  });

  // ── saveVmConnection matches by spawnId ──────────────────────────────

  describe("saveVmConnection with spawnId", () => {
    it("attaches connection to the correct record by spawnId", () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();

      // Save two records for the same cloud
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

      // Attach connection to the FIRST record by id
      saveVmConnection("1.2.3.4", "root", "srv-1", "my-server", "gcp", undefined, undefined, id1);

      const history = loadHistory();
      expect(history[0].connection?.ip).toBe("1.2.3.4");
      expect(history[0].connection?.server_name).toBe("my-server");
      // Second record should NOT have a connection
      expect(history[1].connection).toBeUndefined();
    });

    it("does not cross-contaminate concurrent spawns on the same cloud", () => {
      const id1 = generateSpawnId();
      const id2 = generateSpawnId();

      saveSpawnRecord({
        id: id1,
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      saveSpawnRecord({
        id: id2,
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-01-01T00:01:00.000Z",
      });

      // Each connection targets its own record
      saveVmConnection("10.0.0.1", "root", "srv-a", "server-a", "hetzner", undefined, undefined, id1);
      saveVmConnection("10.0.0.2", "root", "srv-b", "server-b", "hetzner", undefined, undefined, id2);

      const history = loadHistory();
      expect(history[0].connection?.ip).toBe("10.0.0.1");
      expect(history[0].connection?.server_name).toBe("server-a");
      expect(history[1].connection?.ip).toBe("10.0.0.2");
      expect(history[1].connection?.server_name).toBe("server-b");
    });

    it("writes spawn_id to last-connection.json", () => {
      const id = generateSpawnId();
      saveSpawnRecord({
        id,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      saveVmConnection("1.2.3.4", "root", "", "srv", "gcp", undefined, undefined, id);

      const connFile = JSON.parse(readFileSync(getConnectionPath(), "utf-8"));
      expect(connFile.spawn_id).toBe(id);
    });

    it("falls back to heuristic when spawnId is not provided", () => {
      saveSpawnRecord({
        id: generateSpawnId(),
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      // No spawnId — should match the most recent gcp record without connection
      saveVmConnection("5.6.7.8", "user", "", "fallback-srv", "gcp");

      const history = loadHistory();
      expect(history[0].connection?.ip).toBe("5.6.7.8");
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
      });
      saveSpawnRecord({
        id: id2,
        agent: "codex",
        cloud: "gcp",
        timestamp: "2026-01-01T00:01:00.000Z",
      });

      // Attach connections to both
      saveVmConnection("1.1.1.1", "root", "", "srv1", "gcp", undefined, undefined, id1);
      saveVmConnection("2.2.2.2", "root", "", "srv2", "gcp", undefined, undefined, id2);

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
      });
      saveVmConnection("1.1.1.1", "root", "", "srv", "gcp", undefined, undefined, id);

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
      });
      saveSpawnRecord({
        id: id2,
        agent: "codex",
        cloud: "gcp",
        timestamp: "2026-01-01T00:01:00.000Z",
      });

      // Attach connections to both
      saveVmConnection("1.1.1.1", "root", "srv1", "server1", "gcp", undefined, undefined, id1);
      saveVmConnection("2.2.2.2", "root", "srv2", "server2", "gcp", undefined, undefined, id2);

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

  // ── mergeLastConnection uses spawn_id ─────────────────────────────────

  describe("mergeLastConnection via getActiveServers", () => {
    it("merges connection to correct record using spawn_id in last-connection.json", () => {
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

      // Manually write last-connection.json with spawn_id targeting the second record
      const connData = {
        ip: "9.9.9.9",
        user: "root",
        server_name: "targeted-srv",
        cloud: "gcp",
        spawn_id: id2,
      };
      writeFileSync(getConnectionPath(), JSON.stringify(connData) + "\n");

      // getActiveServers triggers mergeLastConnection
      const servers = loadHistory();
      // Force merge by calling getActiveServers (it calls mergeLastConnection internally)
      getActiveServers();

      const history = loadHistory();
      // The first record should NOT have the connection
      expect(history[0].connection).toBeUndefined();
      // The second record should have it
      expect(history[1].connection?.ip).toBe("9.9.9.9");
      expect(history[1].connection?.server_name).toBe("targeted-srv");
    });

    it("falls back to heuristic when last-connection.json has no spawn_id", () => {
      const id1 = generateSpawnId();
      saveSpawnRecord({
        id: id1,
        agent: "claude",
        cloud: "gcp",
        timestamp: "2026-01-01T00:00:00.000Z",
      });

      // Write last-connection.json WITHOUT spawn_id
      const connData = {
        ip: "8.8.8.8",
        user: "root",
        cloud: "gcp",
      };
      writeFileSync(getConnectionPath(), JSON.stringify(connData) + "\n");

      getActiveServers();

      const history = loadHistory();
      expect(history[0].connection?.ip).toBe("8.8.8.8");
    });
  });
});
