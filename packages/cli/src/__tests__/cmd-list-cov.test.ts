/**
 * cmd-list-cov.test.ts — Coverage tests for commands/list.ts
 *
 * Focuses on uncovered paths: formatRelativeTime edge cases, buildRecordLabel,
 * buildRecordSubtitle, resolveListFilters, showEmptyListMessage, cmdListClear,
 * cmdList non-interactive path, cmdLast with no history, handleRecordAction branches.
 */

import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetCacheForTesting, loadManifest } from "../manifest";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

const clack = mockClackPrompts();

const { formatRelativeTime, buildRecordLabel, buildRecordSubtitle, cmdList, cmdListClear, cmdLast } = await import(
  "../commands/index.js"
);
const { resolveListFilters } = await import("../commands/list.js");

const mockManifest = createMockManifest();

describe("commands/list.ts coverage", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    originalFetch = global.fetch;
    originalEnv = {
      ...process.env,
    };
    testDir = join(process.env.HOME ?? "", `.spawn-test-list-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    process.env.SPAWN_HOME = testDir;
    _resetCacheForTesting();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    }
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── formatRelativeTime ────────────────────────────────────────────────

  describe("formatRelativeTime", () => {
    it("returns 'just now' for timestamps less than 60 seconds ago", () => {
      const now = new Date();
      expect(formatRelativeTime(now.toISOString())).toBe("just now");
    });

    it("returns 'just now' for future timestamps", () => {
      const future = new Date(Date.now() + 60000);
      expect(formatRelativeTime(future.toISOString())).toBe("just now");
    });

    it("returns 'X min ago' for recent timestamps", () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinAgo.toISOString())).toBe("5 min ago");
    });

    it("returns 'Xh ago' for hour-old timestamps", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoHoursAgo.toISOString())).toBe("2h ago");
    });

    it("returns 'yesterday' for 1-day-old timestamps", () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(yesterday.toISOString())).toBe("yesterday");
    });

    it("returns 'Xd ago' for multi-day timestamps", () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(fiveDaysAgo.toISOString())).toBe("5d ago");
    });

    it("returns formatted date for old timestamps (>30 days)", () => {
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const result = formatRelativeTime(old.toISOString());
      // Should be like "Jan 17" or similar
      expect(result).not.toContain("ago");
      expect(result).not.toBe("just now");
    });

    it("returns raw string for invalid date", () => {
      expect(formatRelativeTime("not-a-date")).toBe("not-a-date");
    });

    it("returns raw string for empty string", () => {
      expect(formatRelativeTime("")).toBe("");
    });
  });

  // ── buildRecordLabel ──────────────────────────────────────────────────

  describe("buildRecordLabel", () => {
    it("returns name when set", () => {
      const r: SpawnRecord = {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
        name: "my-server",
      };
      expect(buildRecordLabel(r)).toBe("my-server");
    });

    it("falls back to server_name when no name", () => {
      const r: SpawnRecord = {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
        connection: {
          ip: "1.2.3.4",
          user: "root",
          server_name: "srv-123",
        },
      };
      expect(buildRecordLabel(r)).toBe("srv-123");
    });

    it("returns 'unnamed' when no name or server_name", () => {
      const r: SpawnRecord = {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
      };
      expect(buildRecordLabel(r)).toBe("unnamed");
    });
  });

  // ── buildRecordSubtitle ───────────────────────────────────────────────

  describe("buildRecordSubtitle", () => {
    it("includes agent, cloud, and time", () => {
      const r: SpawnRecord = {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      };
      const subtitle = buildRecordSubtitle(r, mockManifest);
      expect(subtitle).toContain("Claude Code");
      expect(subtitle).toContain("Sprite");
    });

    it("shows [deleted] for deleted connections", () => {
      const r: SpawnRecord = {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          deleted: true,
        },
      };
      const subtitle = buildRecordSubtitle(r, mockManifest);
      expect(subtitle).toContain("[deleted]");
    });

    it("falls back to key when manifest is null", () => {
      const r: SpawnRecord = {
        id: "1",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
      };
      const subtitle = buildRecordSubtitle(r, null);
      expect(subtitle).toContain("claude");
      expect(subtitle).toContain("sprite");
    });
  });

  // ── resolveListFilters ────────────────────────────────────────────────

  describe("resolveListFilters", () => {
    it("returns null manifest when fetch fails", async () => {
      _resetCacheForTesting();
      global.fetch = mock(
        async () =>
          new Response("error", {
            status: 500,
          }),
      );
      // Also clear disk cache to force a network fetch
      const cacheDir = join(process.env.XDG_CACHE_HOME || "", "spawn");
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, {
          recursive: true,
          force: true,
        });
      }
      const result = await resolveListFilters("claude");
      expect(result.manifest).toBeNull();
    });

    it("resolves agent filter to key", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      const result = await resolveListFilters("claude");
      expect(result.agentFilter).toBe("claude");
    });

    it("swaps agent filter to cloud when it matches a cloud", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      const result = await resolveListFilters("sprite");
      expect(result.cloudFilter).toBe("sprite");
      expect(result.agentFilter).toBeUndefined();
    });
  });

  // ── cmdListClear ──────────────────────────────────────────────────────

  describe("cmdListClear", () => {
    it("reports no history when empty", async () => {
      await cmdListClear();
      expect(clack.logInfo).toHaveBeenCalled();
    });

    it("clears history when confirmed in non-interactive mode", async () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
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
      // Make non-interactive
      process.env.SPAWN_NON_INTERACTIVE = "1";
      await cmdListClear();
      expect(clack.logSuccess).toHaveBeenCalled();
    });
  });

  // ── cmdList non-interactive ───────────────────────────────────────────

  describe("cmdList", () => {
    it("shows empty message when no history", async () => {
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList();
      expect(clack.logInfo).toHaveBeenCalled();
    });

    it("shows history table in non-interactive mode", async () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          name: "test-srv",
        },
      ];
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records,
        }),
      );
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList();
      // Should have called console.log for the table
      expect(consoleMocks.log).toHaveBeenCalled();
    });

    it("shows filtered results with agent filter", async () => {
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
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList("claude");
      expect(consoleMocks.log).toHaveBeenCalled();
    });
  });

  // ── cmdLast ───────────────────────────────────────────────────────────

  describe("cmdLast", () => {
    it("shows no-history message when empty", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await cmdLast();
      expect(clack.logInfo).toHaveBeenCalled();
    });
  });
});
