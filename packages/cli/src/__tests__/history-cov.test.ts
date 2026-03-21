/**
 * history-cov.test.ts — Coverage tests for history.ts
 *
 * Focuses on uncovered paths: saveLaunchCmd, saveMetadata,
 * markRecordDeleted, updateRecordIp, updateRecordConnection, getActiveServers,
 * removeRecord, and v1 loose schema handling.
 * (generateSpawnId is covered in history-spawn-id.test.ts)
 * (clearHistory is covered in clear-history.test.ts)
 * (filterHistory ordering and no-cap behavior covered in history-trimming.test.ts)
 */

import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getActiveServers,
  loadHistory,
  markRecordDeleted,
  removeRecord,
  saveLaunchCmd,
  saveMetadata,
  updateRecordConnection,
  updateRecordIp,
} from "../history.js";

describe("history.ts coverage", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `.spawn-test-hist-${Date.now()}-${Math.random()}`);
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

  // ── saveLaunchCmd ─────────────────────────────────────────────────────

  describe("saveLaunchCmd", () => {
    it("saves launch cmd by spawnId", () => {
      const record: SpawnRecord = {
        id: "test-id-1",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
        connection: {
          ip: "1.2.3.4",
          user: "root",
        },
      };
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records: [
            record,
          ],
        }),
      );

      saveLaunchCmd("claude --resume", "test-id-1");

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.launch_cmd).toBe("claude --resume");
    });

    it("falls back to most recent record with connection when no spawnId", () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          id: "2",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      saveLaunchCmd("codex start");

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[1].connection.launch_cmd).toBe("codex start");
    });

    it("does nothing when no record matches spawnId", () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      saveLaunchCmd("test-cmd", "nonexistent-id");

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.launch_cmd).toBeUndefined();
    });
  });

  // ── saveMetadata ──────────────────────────────────────────────────────

  describe("saveMetadata", () => {
    it("saves metadata by spawnId", () => {
      const records: SpawnRecord[] = [
        {
          id: "meta-1",
          agent: "claude",
          cloud: "gcp",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      saveMetadata(
        {
          zone: "us-central1-a",
          project: "my-project",
        },
        "meta-1",
      );

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.metadata.zone).toBe("us-central1-a");
      expect(data.records[0].connection.metadata.project).toBe("my-project");
    });

    it("merges metadata with existing", () => {
      const records: SpawnRecord[] = [
        {
          id: "meta-2",
          agent: "claude",
          cloud: "gcp",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            metadata: {
              zone: "us-east1-b",
            },
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      saveMetadata(
        {
          project: "new-project",
        },
        "meta-2",
      );

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.metadata.zone).toBe("us-east1-b");
      expect(data.records[0].connection.metadata.project).toBe("new-project");
    });

    it("falls back to most recent record without spawnId", () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      saveMetadata({
        key: "value",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.metadata.key).toBe("value");
    });
  });

  // ── markRecordDeleted ─────────────────────────────────────────────────

  describe("markRecordDeleted", () => {
    it("marks a record as deleted", () => {
      const records: SpawnRecord[] = [
        {
          id: "del-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = markRecordDeleted(records[0]);
      expect(result).toBe(true);

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.deleted).toBe(true);
      expect(data.records[0].connection.deleted_at).toBeTruthy();
    });

    it("returns false for non-existent record", () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records: [],
        }),
      );
      const result = markRecordDeleted({
        id: "nonexistent",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
      });
      expect(result).toBe(false);
    });

    it("returns false for record without connection", () => {
      const records: SpawnRecord[] = [
        {
          id: "no-conn",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = markRecordDeleted(records[0]);
      expect(result).toBe(false);
    });
  });

  // ── updateRecordIp ────────────────────────────────────────────────────

  describe("updateRecordIp", () => {
    it("updates IP address", () => {
      const records: SpawnRecord[] = [
        {
          id: "ip-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = updateRecordIp(records[0], "5.6.7.8");
      expect(result).toBe(true);

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.ip).toBe("5.6.7.8");
    });

    it("returns false for missing record", () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records: [],
        }),
      );
      const result = updateRecordIp(
        {
          id: "missing",
          agent: "claude",
          cloud: "sprite",
          timestamp: "x",
        },
        "1.1.1.1",
      );
      expect(result).toBe(false);
    });

    it("returns false for record without connection", () => {
      const records: SpawnRecord[] = [
        {
          id: "no-conn",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = updateRecordIp(records[0], "1.1.1.1");
      expect(result).toBe(false);
    });
  });

  // ── updateRecordConnection ────────────────────────────────────────────

  describe("updateRecordConnection", () => {
    it("updates ip, server_id, and server_name", () => {
      const records: SpawnRecord[] = [
        {
          id: "conn-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            server_id: "old-id",
          },
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = updateRecordConnection(records[0], {
        ip: "9.9.9.9",
        server_id: "new-id",
        server_name: "new-name",
      });
      expect(result).toBe(true);

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records[0].connection.ip).toBe("9.9.9.9");
      expect(data.records[0].connection.server_id).toBe("new-id");
      expect(data.records[0].connection.server_name).toBe("new-name");
    });

    it("returns false for missing record", () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records: [],
        }),
      );
      const result = updateRecordConnection(
        {
          id: "missing",
          agent: "claude",
          cloud: "sprite",
          timestamp: "x",
        },
        {
          ip: "1.1.1.1",
        },
      );
      expect(result).toBe(false);
    });
  });

  // ── getActiveServers ──────────────────────────────────────────────────

  describe("getActiveServers", () => {
    it("returns records with non-local, non-deleted connections", () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            cloud: "sprite",
          },
        },
        {
          id: "2",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-02T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            cloud: "local",
          },
        },
        {
          id: "3",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-03T00:00:00Z",
          connection: {
            ip: "1.2.3.4",
            user: "root",
            cloud: "hetzner",
            deleted: true,
          },
        },
        {
          id: "4",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-04T00:00:00Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const active = getActiveServers();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe("1");
    });

    it("returns empty for no records", () => {
      expect(getActiveServers()).toEqual([]);
    });
  });

  // ── removeRecord ──────────────────────────────────────────────────────

  describe("removeRecord", () => {
    it("removes record by id", () => {
      const records: SpawnRecord[] = [
        {
          id: "rm-1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          id: "rm-2",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = removeRecord(records[0]);
      expect(result).toBe(true);

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      expect(data.records).toHaveLength(1);
      expect(data.records[0].id).toBe("rm-2");
    });

    it("finds record by timestamp+agent+cloud fallback when no id", () => {
      const records: SpawnRecord[] = [
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      const result = removeRecord({
        id: "",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
      });
      expect(result).toBe(true);
    });

    it("returns false for non-existent record", () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records: [],
        }),
      );
      const result = removeRecord({
        id: "nope",
        agent: "claude",
        cloud: "sprite",
        timestamp: "x",
      });
      expect(result).toBe(false);
    });
  });

  // ── v1 loose schema ───────────────────────────────────────────────────

  describe("v1 loose schema handling", () => {
    it("drops malformed records but keeps valid ones", () => {
      const logSpy = spyOn(console, "error").mockImplementation(() => {});
      const data = {
        version: 1,
        records: [
          {
            agent: "claude",
            cloud: "sprite",
            timestamp: "2026-01-01T00:00:00Z",
          },
          {
            bad: "record",
          },
          {
            agent: "codex",
            cloud: "hetzner",
            timestamp: "2026-01-02T00:00:00Z",
          },
        ],
      };
      writeFileSync(join(testDir, "history.json"), JSON.stringify(data));

      const records = loadHistory();
      expect(records).toHaveLength(2);
      logSpy.mockRestore();
    });
  });
});
