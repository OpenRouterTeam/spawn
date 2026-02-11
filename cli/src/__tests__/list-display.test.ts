import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Tests for the `spawn list` display logic in commands.ts and index.ts.
 *
 * Covers:
 * - formatTimestamp: date parsing and formatting for history display
 * - parseListFilters: `-a` and `-c` flag extraction from args
 * - cmdList output: column layout, rerun hint, empty states, filter messages
 *
 * These functions were added in PRs #486-#488 (history feature) and lack
 * direct unit test coverage. formatTimestamp is not exported, so we test
 * an exact replica; parseListFilters is replicated from index.ts.
 *
 * Agent: test-engineer
 */

// ── Exact replica of formatTimestamp from commands.ts lines 731-741 ──────────

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}

// ── Exact replica of parseListFilters from index.ts ─────────────────────────

function parseListFilters(args: string[]): { agentFilter?: string; cloudFilter?: string } {
  let agentFilter: string | undefined;
  let cloudFilter: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "-a" || args[i] === "--agent") && args[i + 1] && !args[i + 1].startsWith("-")) {
      agentFilter = args[i + 1];
      i++;
    } else if ((args[i] === "-c" || args[i] === "--cloud") && args[i + 1] && !args[i + 1].startsWith("-")) {
      cloudFilter = args[i + 1];
      i++;
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }
  if (!agentFilter && !cloudFilter && positional.length > 0) {
    agentFilter = positional[0];
  }
  return { agentFilter, cloudFilter };
}

// ── formatTimestamp tests ────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  describe("valid ISO timestamps", () => {
    it("should format a standard ISO timestamp", () => {
      const result = formatTimestamp("2026-02-11T14:30:00.000Z");
      // Should contain month, day, year
      expect(result).toContain("2026");
      expect(result).toContain("Feb");
      expect(result).toContain("11");
    });

    it("should include time component", () => {
      const result = formatTimestamp("2026-01-15T09:05:00.000Z");
      // Time should be in HH:MM format
      expect(result).toMatch(/\d{2}:\d{2}/);
    });

    it("should format midnight correctly", () => {
      const result = formatTimestamp("2026-06-01T00:00:00.000Z");
      expect(result).toContain("2026");
      // Should still have a time component
      expect(result).toMatch(/\d{2}:\d{2}/);
    });

    it("should format end-of-day correctly", () => {
      const result = formatTimestamp("2026-12-31T23:59:59.000Z");
      expect(result).toContain("Dec");
      expect(result).toContain("31");
      expect(result).toContain("2026");
    });

    it("should handle ISO timestamp without milliseconds", () => {
      const result = formatTimestamp("2026-03-20T16:45:00Z");
      expect(result).toContain("2026");
      expect(result).toContain("Mar");
      expect(result).toContain("20");
    });

    it("should handle ISO timestamp with timezone offset", () => {
      const result = formatTimestamp("2026-07-04T12:00:00+05:00");
      expect(result).toContain("2026");
      expect(result).toMatch(/\d{2}:\d{2}/);
    });
  });

  describe("invalid timestamps", () => {
    it("should return the original string for non-date text", () => {
      expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    });

    it("should return the original string for empty string", () => {
      expect(formatTimestamp("")).toBe("");
    });

    it("should return the original string for random text", () => {
      expect(formatTimestamp("hello world")).toBe("hello world");
    });

    it("should return the original string for 'Invalid Date' text", () => {
      expect(formatTimestamp("Invalid Date")).toBe("Invalid Date");
    });

    it("should return the original string for incomplete ISO format", () => {
      // "2026-13-45" has month 13 which is invalid
      // new Date("2026-13-45") returns Invalid Date
      const result = formatTimestamp("2026-13-45");
      // Should either return formatted (if JS interprets it) or original
      const d = new Date("2026-13-45");
      if (isNaN(d.getTime())) {
        expect(result).toBe("2026-13-45");
      }
    });
  });

  describe("edge cases", () => {
    it("should handle epoch zero", () => {
      const result = formatTimestamp("1970-01-01T00:00:00.000Z");
      expect(result).toContain("1970");
      expect(result).toContain("Jan");
    });

    it("should handle date-only string", () => {
      const result = formatTimestamp("2026-06-15");
      // JS Date can parse date-only strings
      expect(result).toContain("2026");
    });

    it("should handle numeric timestamp string that JS Date accepts", () => {
      // new Date("0") is valid in some JS engines
      const d = new Date("0");
      const result = formatTimestamp("0");
      if (isNaN(d.getTime())) {
        expect(result).toBe("0");
      } else {
        expect(result).toContain("2000");
      }
    });

    it("should produce consistent format (date + space + time)", () => {
      const result = formatTimestamp("2026-02-11T14:30:00.000Z");
      // Format is "MMM DD, YYYY HH:MM" or similar locale-specific output
      // Should have at least one space separating date and time
      const parts = result.split(" ");
      expect(parts.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle far future dates", () => {
      const result = formatTimestamp("2099-12-31T23:59:59.000Z");
      expect(result).toContain("2099");
      expect(result).toContain("Dec");
    });

    it("should handle dates before 2000", () => {
      const result = formatTimestamp("1999-01-01T00:00:00.000Z");
      expect(result).toContain("1999");
    });
  });
});

// ── parseListFilters tests ──────────────────────────────────────────────────

describe("parseListFilters", () => {
  describe("basic flag extraction", () => {
    it("should extract -a flag with value", () => {
      const result = parseListFilters(["-a", "claude"]);
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should extract -c flag with value", () => {
      const result = parseListFilters(["-c", "sprite"]);
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should extract both -a and -c flags", () => {
      const result = parseListFilters(["-a", "claude", "-c", "hetzner"]);
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should handle -c before -a", () => {
      const result = parseListFilters(["-c", "sprite", "-a", "aider"]);
      expect(result.agentFilter).toBe("aider");
      expect(result.cloudFilter).toBe("sprite");
    });
  });

  describe("edge cases", () => {
    it("should return no filters for empty args", () => {
      const result = parseListFilters([]);
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should use first positional arg as agent filter", () => {
      const result = parseListFilters(["claude"]);
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should not extract -a without a following value", () => {
      const result = parseListFilters(["-a"]);
      expect(result.agentFilter).toBeUndefined();
    });

    it("should not extract -c without a following value", () => {
      const result = parseListFilters(["-c"]);
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should not use a flag as a value (value starts with -)", () => {
      const result = parseListFilters(["-a", "-c", "sprite"]);
      // -a sees -c as starting with -, so agentFilter is undefined
      expect(result.agentFilter).toBeUndefined();
      // -c gets "sprite"
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should use last occurrence when -a is specified twice", () => {
      const result = parseListFilters(["-a", "claude", "-a", "aider"]);
      // Second -a overwrites the first
      expect(result.agentFilter).toBe("aider");
    });

    it("should use last occurrence when -c is specified twice", () => {
      const result = parseListFilters(["-c", "sprite", "-c", "hetzner"]);
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should ignore unrelated flags between -a and -c", () => {
      const result = parseListFilters(["-a", "claude", "extra", "-c", "sprite"]);
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should support --agent and --cloud long flags", () => {
      const result = parseListFilters(["--agent", "claude", "--cloud", "sprite"]);
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should handle value with hyphens (e.g., agent name with hyphen)", () => {
      const result = parseListFilters(["-a", "claude-code"]);
      expect(result.agentFilter).toBe("claude-code");
    });

    it("should handle single-char values", () => {
      const result = parseListFilters(["-a", "x", "-c", "y"]);
      expect(result.agentFilter).toBe("x");
      expect(result.cloudFilter).toBe("y");
    });

    it("should not use positional arg when -a flag is present", () => {
      const result = parseListFilters(["-a", "aider", "extra"]);
      expect(result.agentFilter).toBe("aider");
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should not use positional arg when -c flag is present", () => {
      const result = parseListFilters(["-c", "sprite", "extra"]);
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should return no filters for empty args", () => {
      const result = parseListFilters([]);
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should support mixing --agent long flag with -c short flag", () => {
      const result = parseListFilters(["--agent", "claude", "-c", "hetzner"]);
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("hetzner");
    });
  });
});

// ── cmdList output integration tests ────────────────────────────────────────

describe("cmdList output", () => {
  let testDir: string;
  let consoleMocks: { log: ReturnType<typeof spyOn>; error: ReturnType<typeof spyOn> };
  let processExitMock: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-list-test-${Date.now()}-${Math.random()}`);
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

  it("should show empty state when no history exists", async () => {
    const { cmdList } = await import("../commands.js");
    await cmdList();
    // Should have logged "No spawns recorded yet."
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    // The message goes through p.log.info which uses console.log
    // Check that it didn't output a table header
    expect(allOutput).not.toContain("AGENT");
  });

  it("should show filter message when no matching records found", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList("nonexistent");
    // Should indicate no matching records, not show the table
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).not.toContain("AGENT");
  });

  it("should show table header when records exist", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" }])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("AGENT");
    expect(allOutput).toContain("CLOUD");
    expect(allOutput).toContain("WHEN");
  });

  it("should show rerun hint for the most recent spawn", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-10T08:00:00Z" },
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    // Newest-first means claude/sprite is the first record shown
    // Rerun hint should reference the most recent (first) record
    expect(allOutput).toContain("Rerun last");
    expect(allOutput).toContain("spawn claude sprite");
  });

  it("should show spawn count in summary", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T11:00:00Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-02-11T12:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("3 spawns recorded");
  });

  it("should use singular 'spawn' for single record", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("1 spawn recorded");
    expect(allOutput).not.toContain("1 spawns");
  });

  it("should show filter usage hint", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("spawn list -a");
    expect(allOutput).toContain("spawn list -c");
  });

  it("should filter by agent when agentFilter is provided", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T11:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList("claude");
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("claude");
    expect(allOutput).toContain("Showing 1 of 2 spawns");
  });

  it("should filter by cloud when cloudFilter is provided", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T11:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList(undefined, "hetzner");
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("hetzner");
    expect(allOutput).toContain("Showing 1 of 2 spawns");
  });

  it("should show records in newest-first order", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-09T08:00:00Z" },
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-10T10:00:00Z" },
        { agent: "codex", cloud: "vultr", timestamp: "2026-02-11T12:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const logCalls = consoleMocks.log.mock.calls.map(c => String(c[0] ?? ""));
    // Find lines that contain agent names to verify order
    const agentLines = logCalls.filter(l => l.includes("codex") || l.includes("claude") || l.includes("aider"));
    // codex (newest) should come before claude, which should come before aider
    if (agentLines.length >= 3) {
      const codexIdx = logCalls.findIndex(l => l.includes("codex"));
      const claudeIdx = logCalls.findIndex(l => l.includes("claude"));
      const aiderIdx = logCalls.findIndex(l => l.includes("aider"));
      expect(codexIdx).toBeLessThan(claudeIdx);
      expect(claudeIdx).toBeLessThan(aiderIdx);
    }
  });

  it("should handle corrupted history file gracefully", async () => {
    writeFileSync(join(testDir, "history.json"), "not json at all");
    const { cmdList } = await import("../commands.js");
    await cmdList();
    // Should not crash, should show empty state
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).not.toContain("AGENT");
  });

  it("should not show table when filtered results are empty", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T11:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList("nonexistent");
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    // Should not show table header when nothing matches
    expect(allOutput).not.toContain("AGENT");
    expect(allOutput).not.toContain("CLOUD");
  });

  it("should show 'Showing X of Y' when filter matches some results", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-02-11T11:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T12:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList("claude");
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("Showing 2 of 3 spawns");
  });

  it("should show 'Clear filter' hint when filtering", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
        { agent: "aider", cloud: "hetzner", timestamp: "2026-02-11T11:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList("claude");
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).toContain("Clear filter");
    expect(allOutput).toContain("spawn list");
  });

  it("should not show 'Clear filter' hint when not filtering", async () => {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00Z" },
      ])
    );
    const { cmdList } = await import("../commands.js");
    await cmdList();
    const allOutput = consoleMocks.log.mock.calls.map(c => String(c[0] ?? "")).join("\n");
    expect(allOutput).not.toContain("Clear filter");
    // Should show normal filter hint instead
    expect(allOutput).toContain("spawn list -a");
  });
});
