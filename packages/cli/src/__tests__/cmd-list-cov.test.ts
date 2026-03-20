/**
 * cmd-list-cov.test.ts — Coverage tests for commands/list.ts
 *
 * Focuses on uncovered paths: resolveListFilters, showEmptyListMessage,
 * cmdList non-interactive path, handleRecordAction branches.
 * (buildRecordLabel/buildRecordSubtitle covered in cmdlast.test.ts)
 * (cmdListClear covered in clear-history.test.ts)
 * (cmdLast covered in cmdlast.test.ts)
 * (formatRelativeTime covered in commands-exported-utils.test.ts)
 */

import type { SpawnRecord } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetCacheForTesting, loadManifest } from "../manifest";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

const clack = mockClackPrompts();

const { cmdList } = await import("../commands/index.js");
const { resolveListFilters, handleRecordAction, RecordActionOutcome } = await import("../commands/list.js");

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
      // Clear ALL disk cache locations to force a network fetch
      for (const base of [
        process.env.XDG_CACHE_HOME || "",
        join(process.env.HOME || "", ".cache"),
      ]) {
        const cacheDir = join(base, "spawn");
        if (existsSync(cacheDir)) {
          rmSync(cacheDir, {
            recursive: true,
            force: true,
          });
        }
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

  // ── cmdList with cloud filter ──────────────────────────────────────

  describe("cmdList with cloud filter", () => {
    it("shows filtered results with cloud filter in non-interactive mode", async () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          name: "sprite-srv",
        },
        {
          id: "2",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00Z",
          name: "hetzner-srv",
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
      await cmdList(undefined, "sprite");
      expect(consoleMocks.log).toHaveBeenCalled();
    });

    it("shows empty message with agent filter that matches nothing", async () => {
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList("nonexistent-agent");
      expect(clack.logInfo).toHaveBeenCalled();
    });

    it("shows empty message with cloud filter and history exists", async () => {
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
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList(undefined, "nonexistent-cloud");
      expect(clack.logInfo).toHaveBeenCalled();
    });
  });

  // ── resolveListFilters additional ──────────────────────────────────

  describe("resolveListFilters additional", () => {
    it("resolves cloud filter to key", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      const result = await resolveListFilters(undefined, "sprite");
      expect(result.cloudFilter).toBe("sprite");
    });

    it("passes through unresolvable agent filter when cloud also given", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      const result = await resolveListFilters("nonexistent", "sprite");
      expect(result.agentFilter).toBe("nonexistent");
      expect(result.cloudFilter).toBe("sprite");
    });
  });

  // ── handleRecordAction — only testable branches ────────────────────
  // NOTE: rerun/fix/enter/reconnect/dashboard actions call real I/O
  // (cmdRun, fixSpawn, cmdConnect, etc.) and cannot be tested without
  // mock.module for non-clack modules. Only "remove" and "cancel" are
  // testable via the mock.

  describe("handleRecordAction testable branches", () => {
    it("handles remove action", async () => {
      clack.select.mockResolvedValueOnce("remove");
      const record: SpawnRecord = {
        id: "rm-test",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "sprite",
          server_name: "test-srv",
          server_id: "123",
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
      const result = await handleRecordAction(record, mockManifest);
      expect(result).toBe(RecordActionOutcome.Back);
      expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Removed"));
    });

    it("handles remove when record not found in history", async () => {
      clack.select.mockResolvedValueOnce("remove");
      const record: SpawnRecord = {
        id: "not-in-file",
        agent: "claude",
        cloud: "sprite",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "sprite",
        },
      };
      // Write empty history so removeRecord returns false
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          version: 1,
          records: [],
        }),
      );
      const result = await handleRecordAction(record, mockManifest);
      expect(result).toBe(RecordActionOutcome.Back);
      expect(clack.logWarn).toHaveBeenCalledWith(expect.stringContaining("Could not find"));
    });
  });

  // ── buildListFooterLines via cmdList ──────────────────────────────

  describe("buildListFooterLines via non-interactive cmdList", () => {
    it("shows footer with no filter", async () => {
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
      const allCalls = consoleMocks.log.mock.calls.flat().map(String);
      expect(allCalls.some((c) => c.includes("Rerun") || c.includes("recorded"))).toBe(true);
    });

    it("shows filtered footer with agent filter", async () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          name: "test-srv",
        },
        {
          id: "2",
          agent: "codex",
          cloud: "sprite",
          timestamp: "2026-01-02T00:00:00Z",
          name: "test-srv-2",
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
      const allCalls = consoleMocks.log.mock.calls.flat().map(String);
      expect(allCalls.some((c) => c.includes("Showing") || c.includes("Rerun"))).toBe(true);
    });
  });

  // ── showEmptyListMessage paths ────────────────────────────────────

  describe("showEmptyListMessage via cmdList", () => {
    it("shows no spawns message without filters", async () => {
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList();
      const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoCalls.some((msg: string) => msg.includes("No spawns recorded"))).toBe(true);
    });

    it("shows filter mismatch message with agent filter", async () => {
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList("nonexistent");
      const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoCalls.some((msg: string) => msg.includes("No spawns found matching"))).toBe(true);
    });

    it("shows total count when records exist but filter matches nothing", async () => {
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
      process.env.SPAWN_NON_INTERACTIVE = "1";
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdList("nonexistent-agent");
      const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(infoCalls.some((msg: string) => msg.includes("spawn list") || msg.includes("No spawns"))).toBe(true);
    });
  });

  // ── renderListTable edge cases ────────────────────────────────────

  describe("renderListTable edge cases", () => {
    it("renders table with multiple records", async () => {
      const records: SpawnRecord[] = [
        {
          id: "1",
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          name: "server-1",
        },
        {
          id: "2",
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-02T00:00:00Z",
          name: "server-2",
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
      const allCalls = consoleMocks.log.mock.calls.flat().map(String);
      expect(allCalls.some((c) => c.includes("server-1"))).toBe(true);
    });
  });
});
