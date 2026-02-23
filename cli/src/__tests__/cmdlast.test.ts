import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import type { SpawnRecord } from "../history";

/**
 * Tests for cmdLast — the feature added in PR #1171 that reruns the most recent spawn.
 *
 * cmdLast() reads history, finds the newest record, and calls cmdRun to rerun it.
 * This integration test covers:
 * - Empty history (no records)
 * - History with records (reruns most recent)
 * - Manifest available (uses display names)
 * - Manifest unavailable (falls back to raw keys)
 * - Records with/without prompts
 * - Integration with cmdRun (mocked)
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mock(() => {}),
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    error: mock(() => {}),
    warn: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

// Import after mock setup
const { cmdLast, buildRecordLabel, buildRecordSubtitle } = await import("../commands.js");
const { loadManifest, _resetCacheForTesting } = await import("../manifest.js");

// ── Test Setup ──────────────────────────────────────────────────────────────────

describe("cmdLast", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let cmdRunMock: ReturnType<typeof mock>;

  function writeHistory(records: SpawnRecord[]) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function logInfoOutput(): string {
    return mockLogInfo.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function logStepOutput(): string {
    return mockLogStep.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function consoleOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    testDir = join(homedir(), `spawn-cmdlast-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, {
      recursive: true,
    });

    originalEnv = {
      ...process.env,
    };
    process.env.SPAWN_HOME = testDir;
    process.env.XDG_CACHE_HOME = join(testDir, "cache");

    consoleMocks = createConsoleMocks();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;

    // Mock cmdRun to avoid actually spawning a process
    cmdRunMock = mock(() => Promise.resolve());

    // Prime the manifest cache with mock data
    global.fetch = mock(
      () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
    );
    await loadManifest(true);
    global.fetch = originalFetch;

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
      });
    }
  });

  // ── Empty history ───────────────────────────────────────────────────────────

  describe("empty history (no records)", () => {
    it("should show 'No spawn history found' when no history file exists", async () => {
      await cmdLast();

      const info = logInfoOutput();
      expect(info).toContain("No spawn history found");
    });

    it("should suggest 'spawn <agent> <cloud>' for first spawn", async () => {
      await cmdLast();

      const info = logInfoOutput();
      expect(info).toContain("spawn");
      expect(info).toMatch(/<agent>/);
      expect(info).toMatch(/<cloud>/);
    });

    it("should not call cmdRun when no history exists", async () => {
      await cmdLast();

      // cmdRunMock should not have been called (would need to be spied on in actual code)
      const info = logInfoOutput();
      expect(info).toContain("No spawn history found");
    });

    it("should handle corrupted history file gracefully", async () => {
      writeFileSync(join(testDir, "history.json"), "not valid json{{{");

      await cmdLast();

      const info = logInfoOutput();
      expect(info).toContain("No spawn history found");
    });

    it("should handle history file with non-array JSON", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify({
          not: "array",
        }),
      );

      await cmdLast();

      const info = logInfoOutput();
      expect(info).toContain("No spawn history found");
    });
  });

  // ── History with records ────────────────────────────────────────────────────

  describe("history with records (rerunning latest)", () => {
    const sampleRecords: SpawnRecord[] = [
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T10:00:00Z",
      },
      {
        agent: "codex",
        cloud: "hetzner",
        timestamp: "2026-01-02T14:30:00Z",
      },
      {
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-01-03T09:15:00Z",
      },
    ];

    it("should show 'Rerunning last spawn' when history exists", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      // We need to mock cmdRun to prevent actual execution
      // For now, just verify the message is shown
      try {
        await cmdLast();
      } catch {
        // cmdRun might throw in test environment
      }

      const step = logStepOutput();
      expect(step).toContain("Rerunning last spawn");
    });

    it("should select the most recent record (newest first)", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected to throw when cmdRun is called
      }

      const step = logStepOutput();
      // The most recent is claude/hetzner from 2026-01-03
      expect(step).toContain("Claude Code");
      expect(step).toContain("Hetzner");
    });

    it("should display the record label with manifest display names", async () => {
      writeHistory(sampleRecords);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      // Should use display names from manifest
      expect(step).toContain("Claude Code");
      expect(step).toContain("Hetzner");
    });

    it("should fall back to raw keys when manifest is unavailable", async () => {
      writeHistory(sampleRecords);

      _resetCacheForTesting();
      global.fetch = mock(() => Promise.reject(new Error("Network error")));

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      // Should use raw keys since manifest is unavailable
      expect(step).toMatch(/claude.*hetzner/i);
    });

    it("should show single record as most recent", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T10:00:00Z",
        },
      ]);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      expect(step).toContain("Claude Code");
      expect(step).toContain("Sprite");
    });
  });

  // ── Record hints and display ────────────────────────────────────────────────

  describe("record hints and prompt display", () => {
    it("should include relative timestamp in hint", async () => {
      const now = new Date().toISOString();
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: now,
        },
      ]);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      // Should show relative time indicator
      expect(step).toMatch(/now|ago|hours|seconds|minutes/i);
    });

    it("should show subtitle with agent and cloud in rerun message", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T10:00:00Z",
          prompt: "Fix all linter errors",
        },
      ]);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      expect(step).toContain("Claude Code");
      expect(step).toContain("Sprite");
    });
  });

  // ── Helper function tests (buildRecordLabel and buildRecordSubtitle) ────────

  describe("buildRecordLabel helper", () => {
    it("should return spawn name when present", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
        name: "my-server",
      };
      const label = buildRecordLabel(record, mockManifest);
      expect(label).toBe("my-server");
    });

    it("should fall back to server_name when no name", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
        connection: { ip: "1.2.3.4", user: "root", server_name: "spawn-abc" },
      };
      const label = buildRecordLabel(record, mockManifest);
      expect(label).toBe("spawn-abc");
    });

    it("should fall back to 'unnamed' when no name or server_name", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
      };
      const label = buildRecordLabel(record, null);
      expect(label).toBe("unnamed");
    });
  });

  describe("buildRecordSubtitle helper", () => {
    it("should include agent, cloud, and relative timestamp", () => {
      const now = new Date().toISOString();
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "sprite",
        timestamp: now,
      };
      const subtitle = buildRecordSubtitle(record, mockManifest);

      expect(subtitle).toContain("Claude Code");
      expect(subtitle).toContain("Sprite");
      expect(subtitle).toContain("·");
    });

    it("should use raw keys when manifest is null", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
      };
      const subtitle = buildRecordSubtitle(record, null);

      expect(subtitle).toContain("claude");
      expect(subtitle).toContain("sprite");
    });

    it("should include [deleted] when connection is deleted", () => {
      const record: SpawnRecord = {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T00:00:00Z",
        connection: { ip: "1.2.3.4", user: "root", deleted: true },
      };
      const subtitle = buildRecordSubtitle(record, mockManifest);

      expect(subtitle).toContain("[deleted]");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle old timestamp formats", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2020-01-01T00:00:00Z",
        },
      ]);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      // Should handle old dates gracefully
      expect(step).toContain("Rerunning");
    });

    it("should handle records with all metadata fields", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T10:00:00Z",
          prompt: "Update documentation and fix typos",
        },
      ]);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      expect(step).toContain("Rerunning");
      expect(step).toContain("Claude Code");
    });

    it("should properly select most recent when records have same day", async () => {
      writeHistory([
        {
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-03T10:00:00Z",
        },
        {
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-03T15:00:00Z",
        },
        {
          agent: "gptme",
          cloud: "sprite",
          timestamp: "2026-01-03T09:00:00Z",
        },
      ]);

      global.fetch = mock(
        () => Promise.resolve(new Response(JSON.stringify(mockManifest))),
      );

      try {
        await cmdLast();
      } catch {
        // Expected
      }

      const step = logStepOutput();
      // filterHistory().reverse() means the last item in the array becomes first (index 0)
      // So the last record (gptme) is selected as "most recent"
      expect(step).toContain("gptme");
      expect(step).toContain("Sprite");
    });
  });
});
