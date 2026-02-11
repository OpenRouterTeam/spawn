import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Tests for `formatRelativeTime` and `cmdRerun` functionality.
 *
 * Covers:
 * - formatRelativeTime: relative time formatting for spawn history display
 * - cmdRerun: rerunning a spawn from history by index
 *
 * Agent: ux-engineer
 */

// ── formatRelativeTime ──────────────────────────────────────────────────────

import { formatRelativeTime } from "../commands.js";

describe("formatRelativeTime", () => {
  const now = new Date("2026-02-11T12:00:00.000Z");

  describe("recent times", () => {
    it("should return 'just now' for timestamps within the last minute", () => {
      expect(formatRelativeTime("2026-02-11T11:59:30.000Z", now)).toBe("just now");
    });

    it("should return minutes ago for timestamps within the last hour", () => {
      expect(formatRelativeTime("2026-02-11T11:55:00.000Z", now)).toBe("5m ago");
    });

    it("should return '1m ago' for exactly 1 minute ago", () => {
      expect(formatRelativeTime("2026-02-11T11:59:00.000Z", now)).toBe("1m ago");
    });

    it("should return '59m ago' for 59 minutes ago", () => {
      expect(formatRelativeTime("2026-02-11T11:01:00.000Z", now)).toBe("59m ago");
    });
  });

  describe("hours", () => {
    it("should return hours ago for timestamps within the last day", () => {
      expect(formatRelativeTime("2026-02-11T10:00:00.000Z", now)).toBe("2h ago");
    });

    it("should return '1h ago' for exactly 1 hour ago", () => {
      expect(formatRelativeTime("2026-02-11T11:00:00.000Z", now)).toBe("1h ago");
    });

    it("should return '23h ago' for 23 hours ago", () => {
      expect(formatRelativeTime("2026-02-10T13:00:00.000Z", now)).toBe("23h ago");
    });
  });

  describe("days", () => {
    it("should return days ago for timestamps within the last month", () => {
      expect(formatRelativeTime("2026-02-09T12:00:00.000Z", now)).toBe("2d ago");
    });

    it("should return '1d ago' for exactly 1 day ago", () => {
      expect(formatRelativeTime("2026-02-10T12:00:00.000Z", now)).toBe("1d ago");
    });

    it("should return '29d ago' for 29 days ago", () => {
      expect(formatRelativeTime("2026-01-13T12:00:00.000Z", now)).toBe("29d ago");
    });
  });

  describe("months", () => {
    it("should return months ago for timestamps within the last year", () => {
      expect(formatRelativeTime("2025-12-11T12:00:00.000Z", now)).toBe("2mo ago");
    });

    it("should return '1mo ago' for roughly 1 month ago", () => {
      expect(formatRelativeTime("2026-01-11T12:00:00.000Z", now)).toBe("1mo ago");
    });

    it("should return '11mo ago' for 11 months ago", () => {
      expect(formatRelativeTime("2025-03-14T12:00:00.000Z", now)).toBe("11mo ago");
    });
  });

  describe("years", () => {
    it("should return years ago for timestamps older than a year", () => {
      expect(formatRelativeTime("2024-02-11T12:00:00.000Z", now)).toBe("2y ago");
    });

    it("should return '1y ago' for roughly 1 year ago", () => {
      expect(formatRelativeTime("2025-02-11T12:00:00.000Z", now)).toBe("1y ago");
    });
  });

  describe("edge cases", () => {
    it("should return empty string for invalid timestamps", () => {
      expect(formatRelativeTime("not-a-date", now)).toBe("");
    });

    it("should return empty string for empty string", () => {
      expect(formatRelativeTime("", now)).toBe("");
    });

    it("should return empty string for future timestamps", () => {
      expect(formatRelativeTime("2026-02-12T12:00:00.000Z", now)).toBe("");
    });

    it("should return 'just now' for exact same time", () => {
      expect(formatRelativeTime("2026-02-11T12:00:00.000Z", now)).toBe("just now");
    });

    it("should use current time when no reference provided", () => {
      // A timestamp from 2020 should return years ago regardless of current time
      const result = formatRelativeTime("2020-01-01T00:00:00.000Z");
      expect(result).toMatch(/\d+y ago/);
    });
  });
});

// ── cmdRerun integration tests ──────────────────────────────────────────────

describe("cmdRerun", () => {
  let testDir: string;
  let consoleMocks: { log: ReturnType<typeof spyOn>; error: ReturnType<typeof spyOn> };
  let processExitMock: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-rerun-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    consoleMocks = {
      log: spyOn(console, "log").mockImplementation(() => {}),
      error: spyOn(console, "error").mockImplementation(() => {}),
    };
    processExitMock = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
  });

  afterEach(() => {
    consoleMocks.log.mockRestore();
    consoleMocks.error.mockRestore();
    processExitMock.mockRestore();
    process.env = originalEnv;
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("should exit with error when no history exists", async () => {
    const { cmdRerun } = await import("../commands.js");
    await expect(cmdRerun()).rejects.toThrow("process.exit");
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("should exit with error for invalid index (0)", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdRerun } = await import("../commands.js");
    await expect(cmdRerun(0)).rejects.toThrow("process.exit");
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("should exit with error for index out of range", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdRerun } = await import("../commands.js");
    await expect(cmdRerun(5)).rejects.toThrow("process.exit");
    expect(processExitMock).toHaveBeenCalledWith(1);
  });

  it("should exit with error for negative index", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdRerun } = await import("../commands.js");
    await expect(cmdRerun(-1)).rejects.toThrow("process.exit");
    expect(processExitMock).toHaveBeenCalledWith(1);
  });
});

// ── cmdList with row numbers ────────────────────────────────────────────────

describe("cmdList row numbers", () => {
  let testDir: string;
  let consoleMocks: { log: ReturnType<typeof spyOn>; error: ReturnType<typeof spyOn> };
  let processExitMock: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-list-num-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    consoleMocks = {
      log: spyOn(console, "log").mockImplementation(() => {}),
      error: spyOn(console, "error").mockImplementation(() => {}),
    };
    processExitMock = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
  });

  afterEach(() => {
    consoleMocks.log.mockRestore();
    consoleMocks.error.mockRestore();
    processExitMock.mockRestore();
    process.env = originalEnv;
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("should show row number column header", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("#");
  });

  it("should show rerun command hint", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("spawn rerun");
  });

  it("should show relative time in output", async () => {
    // Use a timestamp that will always produce a relative time
    const recentTs = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: recentTs }])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("ago");
  });
});
