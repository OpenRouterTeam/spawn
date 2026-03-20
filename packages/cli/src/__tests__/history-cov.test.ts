/**
 * history-cov.test.ts — Coverage tests for history.ts
 *
 * Focuses on uncovered paths: saveLaunchCmd, saveMetadata,
 * markRecordDeleted, updateRecordIp, updateRecordConnection, getActiveServers,
 * removeRecord, no-cap behavior, and v1 loose schema handling.
 * (generateSpawnId is covered in history-spawn-id.test.ts)
 * (clearHistory is covered in clear-history.test.ts)
 */

import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  filterHistory,
  getActiveServers,
  loadHistory,
  markRecordDeleted,
  removeRecord,
  saveLaunchCmd,
  saveMetadata,
  saveSpawnRecord,
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

  // ── filterHistory reverse chronological ───────────────────────────────

  describe("filterHistory ordering", () => {
    it("returns results in reverse chronological order", () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          id: "2",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-03T00:00:00Z",
        },
        {
          id: "3",
          agent: "claude",
          cloud: "sprite",
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

      const result = filterHistory();
      // Reverse of storage order (newest first via array reverse)
      expect(result[0].id).toBe("3");
      expect(result[1].id).toBe("2");
      expect(result[2].id).toBe("1");
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

  // ── No trimming — all records retained ───────────────────────────────

  describe("no history cap", () => {
    it("retains all records when over 100 entries", () => {
      // Create 100 non-deleted + 1 deleted = 101 total, all should be kept
      const records: SpawnRecord[] = [];
      for (let i = 0; i < 100; i++) {
        records.push({
          id: `r-${i}`,
          agent: "claude",
          cloud: "sprite",
          timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        });
      }
      records.push({
        id: "del-1",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-02-01T00:00:00Z",
        connection: {
          ip: "1.1.1.1",
          user: "root",
          deleted: true,
        },
      });
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );

      // Save one more — no trimming should occur
      saveSpawnRecord({
        id: "new-1",
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-03-01T00:00:00Z",
      });

      const data = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
      // All 102 records should be retained (101 existing + 1 new)
      expect(data.records).toHaveLength(102);
      // Deleted record should still be present
      const hasDeleted = data.records.some((r: SpawnRecord) => r.connection?.deleted);
      expect(hasDeleted).toBe(true);
    });
  });
});
