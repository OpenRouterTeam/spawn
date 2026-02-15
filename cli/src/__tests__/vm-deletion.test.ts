import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { deleteSpawnRecord, loadHistory, saveSpawnRecord, getHistoryPath, type SpawnRecord } from "../history.js";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

describe("VM deletion", () => {
  const TEST_SPAWN_DIR = "/tmp/spawn-test-vm-deletion";
  const originalEnv = process.env.SPAWN_HOME;

  beforeEach(() => {
    // Use a test directory
    process.env.SPAWN_HOME = TEST_SPAWN_DIR;
    if (existsSync(TEST_SPAWN_DIR)) {
      rmSync(TEST_SPAWN_DIR, { recursive: true });
    }
    mkdirSync(TEST_SPAWN_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_SPAWN_DIR)) {
      rmSync(TEST_SPAWN_DIR, { recursive: true });
    }
    if (originalEnv) {
      process.env.SPAWN_HOME = originalEnv;
    } else {
      delete process.env.SPAWN_HOME;
    }
  });

  describe("deleteSpawnRecord", () => {
    it("should delete a matching record from history", () => {
      const record1: SpawnRecord = {
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2024-01-01T10:00:00Z",
        connection: {
          ip: "1.2.3.4",
          user: "root",
          server_id: "12345",
          server_name: "test-vm-1",
        },
      };
      const record2: SpawnRecord = {
        agent: "openrouter",
        cloud: "digitalocean",
        timestamp: "2024-01-02T10:00:00Z",
        connection: {
          ip: "5.6.7.8",
          user: "root",
          server_id: "67890",
          server_name: "test-vm-2",
        },
      };

      saveSpawnRecord(record1);
      saveSpawnRecord(record2);

      expect(loadHistory().length).toBe(2);

      deleteSpawnRecord(record1);

      const history = loadHistory();
      expect(history.length).toBe(1);
      expect(history[0].timestamp).toBe(record2.timestamp);
      expect(history[0].cloud).toBe(record2.cloud);
      expect(history[0].agent).toBe(record2.agent);
    });

    it("should delete the history file when removing the last record", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2024-01-01T10:00:00Z",
      };

      saveSpawnRecord(record);
      expect(existsSync(getHistoryPath())).toBe(true);

      deleteSpawnRecord(record);

      expect(existsSync(getHistoryPath())).toBe(false);
      expect(loadHistory().length).toBe(0);
    });

    it("should do nothing if record not found", () => {
      const record1: SpawnRecord = {
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2024-01-01T10:00:00Z",
      };
      const record2: SpawnRecord = {
        agent: "openrouter",
        cloud: "digitalocean",
        timestamp: "2024-01-02T10:00:00Z",
      };

      saveSpawnRecord(record1);
      expect(loadHistory().length).toBe(1);

      // Try to delete a record that doesn't exist
      deleteSpawnRecord(record2);

      expect(loadHistory().length).toBe(1);
      expect(loadHistory()[0].timestamp).toBe(record1.timestamp);
    });

    it("should do nothing if history file doesn't exist", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2024-01-01T10:00:00Z",
      };

      expect(existsSync(getHistoryPath())).toBe(false);

      // Should not throw
      deleteSpawnRecord(record);

      expect(existsSync(getHistoryPath())).toBe(false);
    });

    it("should match records by timestamp, cloud, and agent", () => {
      const record1: SpawnRecord = {
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2024-01-01T10:00:00Z",
        prompt: "Test prompt 1",
      };
      const record2: SpawnRecord = {
        agent: "openrouter",
        cloud: "hetzner",
        timestamp: "2024-01-02T10:00:00Z",
        prompt: "Test prompt 2", // Different agent and timestamp
      };

      saveSpawnRecord(record1);
      saveSpawnRecord(record2);

      expect(loadHistory().length).toBe(2);

      // Delete only the first record (matches by timestamp + cloud + agent)
      deleteSpawnRecord(record1);

      // Should delete only the matching record
      const history = loadHistory();
      expect(history.length).toBe(1);
      expect(history[0].agent).toBe("openrouter");
      expect(history[0].timestamp).toBe("2024-01-02T10:00:00Z");
    });
  });
});
