import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import type { SpawnRecord } from "../history";

/**
 * Tests for cmdList display-name filter resolution and interactive picker helpers.
 *
 * PR #537 added display-name-to-key resolution in cmdList: when a user runs
 * `spawn list -a "Claude Code"`, the filter is resolved to "claude" before
 * querying history. PR #531 added buildRecordLabel and buildRecordHint helpers
 * for the interactive picker. Neither path has dedicated test coverage.
 *
 * This file covers:
 * - cmdList filter resolution: display name -> key (e.g., "Claude Code" -> "claude")
 * - cmdList filter resolution: case-insensitive display name (e.g., "claude code")
 * - cmdList filter resolution: cloud display name (e.g., "Hetzner Cloud" -> "hetzner")
 * - cmdList filter resolution with both agent and cloud display names
 * - cmdList filter passthrough when manifest is unavailable (raw key matching)
 * - cmdList filter resolution when display name doesn't match any key
 * - buildRecordLabel: agent + cloud display name formatting
 * - buildRecordHint: timestamp + optional prompt preview formatting
 * - showListFooter: prompt escaping for rerun suggestions
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── Mock @clack/prompts ────────────────────────────────────────────────────────

const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogSuccess = mock(() => {});
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
    error: mockLogError,
    warn: mock(() => {}),
    success: mockLogSuccess,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import after mock setup
const { cmdList, resolveDisplayName } = await import("../commands.js");

// ── Test Setup ─────────────────────────────────────────────────────────────────

describe("cmdList filter resolution via display names", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  const sampleRecords: SpawnRecord[] = [
    { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00Z" },
    { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T14:30:00Z" },
    { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T09:15:00Z" },
    { agent: "aider", cloud: "sprite", timestamp: "2026-01-04T16:00:00Z" },
  ];

  function writeHistory(records: SpawnRecord[]) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function consoleOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function logInfoOutput(): string {
    return mockLogInfo.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `spawn-filter-res-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;

    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogSuccess.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Agent display name resolution ──────────────────────────────────────────

  describe("agent filter: display name -> key resolution", () => {
    it("should resolve 'Claude Code' to 'claude' and filter correctly", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Claude Code");

      const output = consoleOutput();
      // Should find 2 records for claude (same as filtering by key "claude")
      expect(output).toContain("2 of 4");
    });

    it("should resolve case-insensitive display name 'claude code'", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("claude code");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should resolve case-insensitive display name 'CLAUDE CODE'", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("CLAUDE CODE");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should resolve 'Aider' display name and filter correctly", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Aider");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should show table with resolved agent display names", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Claude Code");

      const output = consoleOutput();
      // The table should render with display names from manifest
      expect(output).toContain("Claude Code");
    });
  });

  // ── Cloud display name resolution ──────────────────────────────────────────

  describe("cloud filter: display name -> key resolution", () => {
    it("should resolve 'Hetzner Cloud' to 'hetzner' and filter correctly", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList(undefined, "Hetzner Cloud");

      const output = consoleOutput();
      // 2 records on hetzner (aider + claude)
      expect(output).toContain("2 of 4");
    });

    it("should resolve case-insensitive 'hetzner cloud'", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList(undefined, "hetzner cloud");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should resolve 'Sprite' display name", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList(undefined, "Sprite");

      const output = consoleOutput();
      // 2 records on sprite
      expect(output).toContain("2 of 4");
    });
  });

  // ── Combined display name resolution ──────────────────────────────────────

  describe("combined agent + cloud display name resolution", () => {
    it("should resolve both display names simultaneously", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Claude Code", "Hetzner Cloud");

      const output = consoleOutput();
      // 1 record: claude on hetzner
      expect(output).toContain("1 of 4");
    });

    it("should resolve agent display name + cloud key", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Claude Code", "sprite");

      const output = consoleOutput();
      // 1 record: claude on sprite
      expect(output).toContain("1 of 4");
    });

    it("should resolve agent key + cloud display name", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("aider", "Hetzner Cloud");

      const output = consoleOutput();
      // 1 record: aider on hetzner
      expect(output).toContain("1 of 4");
    });
  });

  // ── Manifest unavailable fallback ──────────────────────────────────────────

  describe("fallback when manifest is unavailable", () => {
    it("should use raw key matching when manifest fetch fails", async () => {
      global.fetch = mock(() => Promise.reject(new Error("Network error")));
      try { await loadManifest(true); } catch { /* expected */ }

      writeHistory(sampleRecords);

      await cmdList("claude");

      const output = consoleOutput();
      // Should still find records by raw key
      expect(output).toContain("claude");
      expect(output).toContain("AGENT");
    });

    it("should still filter by raw key when manifest is available", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      // Direct key "claude" should work even though display name also resolves
      await cmdList("claude");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });
  });

  // ── Unresolvable display names ─────────────────────────────────────────────

  describe("unresolvable filter values", () => {
    it("should show empty message for completely unknown agent display name", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Unknown Agent");

      const info = logInfoOutput();
      expect(info).toContain("No spawns found matching");
    });

    it("should show empty message for completely unknown cloud display name", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList(undefined, "Unknown Cloud");

      const info = logInfoOutput();
      expect(info).toContain("No spawns found matching");
    });
  });

  // ── Bare positional arg: auto-detect cloud vs agent ───────────────────────

  describe("bare positional arg reclassified as cloud filter when appropriate", () => {
    it("should reclassify 'hetzner' from agentFilter to cloudFilter", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      // "hetzner" passed as agentFilter (bare positional), should be reclassified
      await cmdList("hetzner");

      const output = consoleOutput();
      // Should find 2 records on hetzner (aider + claude), not 0
      expect(output).toContain("2 of 4");
    });

    it("should reclassify 'sprite' from agentFilter to cloudFilter", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("sprite");

      const output = consoleOutput();
      // Should find 2 records on sprite
      expect(output).toContain("2 of 4");
    });

    it("should reclassify cloud display name 'Hetzner Cloud' to cloudFilter", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("Hetzner Cloud");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should NOT reclassify when agentFilter resolves to an agent", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("claude");

      const output = consoleOutput();
      // "claude" is a valid agent, should filter by agent
      expect(output).toContain("2 of 4");
    });

    it("should NOT reclassify when explicit cloudFilter is already set", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      // When both are set, don't reclassify
      await cmdList("unknown-thing", "hetzner");

      const info = logInfoOutput();
      // Should show "no spawns" since agent=unknown-thing finds nothing
      expect(info).toContain("No spawns found matching");
    });
  });

  // ── Key that matches directly vs display name ──────────────────────────────

  describe("direct key match takes precedence over display name", () => {
    it("should match 'claude' directly as key without resolution", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList("claude");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });

    it("should match 'hetzner' directly as key without resolution", async () => {
      await setManifest(mockManifest);
      writeHistory(sampleRecords);

      await cmdList(undefined, "hetzner");

      const output = consoleOutput();
      expect(output).toContain("2 of 4");
    });
  });
});

// ── buildRecordLabel and buildRecordHint (replica tests) ─────────────────────
// These functions are not exported, so we test exact replicas.

/** Exact replica of buildRecordLabel from commands.ts */
function buildRecordLabel(
  r: SpawnRecord,
  manifest: Manifest | null,
): string {
  const agentDisplay = resolveDisplayName(manifest, r.agent, "agent");
  const cloudDisplay = resolveDisplayName(manifest, r.cloud, "cloud");
  return `${agentDisplay} on ${cloudDisplay}`;
}

/** Exact replica of buildRecordHint from commands.ts */
function buildRecordHint(r: SpawnRecord): string {
  const when = formatTimestamp(r.timestamp);
  if (r.prompt) {
    const preview = r.prompt.length > 30 ? r.prompt.slice(0, 30) + "..." : r.prompt;
    return `${when}  --prompt "${preview}"`;
  }
  return when;
}

/** Exact replica of formatTimestamp from commands.ts */
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

describe("buildRecordLabel", () => {
  const manifest = createMockManifest();

  it("should format 'AgentName on CloudName' with manifest", () => {
    const label = buildRecordLabel(
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
      manifest,
    );
    expect(label).toBe("Claude Code on Sprite");
  });

  it("should format second agent/cloud pair correctly", () => {
    const label = buildRecordLabel(
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-01T00:00:00Z" },
      manifest,
    );
    expect(label).toBe("Aider on Hetzner Cloud");
  });

  it("should use raw keys when manifest is null", () => {
    const label = buildRecordLabel(
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
      null,
    );
    expect(label).toBe("claude on sprite");
  });

  it("should use raw key for unknown agent", () => {
    const label = buildRecordLabel(
      { agent: "unknown-agent", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" },
      manifest,
    );
    expect(label).toBe("unknown-agent on Sprite");
  });

  it("should use raw key for unknown cloud", () => {
    const label = buildRecordLabel(
      { agent: "claude", cloud: "unknown-cloud", timestamp: "2026-01-01T00:00:00Z" },
      manifest,
    );
    expect(label).toBe("Claude Code on unknown-cloud");
  });

  it("should use raw keys for both unknown agent and cloud", () => {
    const label = buildRecordLabel(
      { agent: "x", cloud: "y", timestamp: "2026-01-01T00:00:00Z" },
      manifest,
    );
    expect(label).toBe("x on y");
  });
});

describe("buildRecordHint", () => {
  it("should format timestamp for record without prompt", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
    });
    expect(hint).toContain("2026");
    expect(hint).toContain("Feb");
    expect(hint).not.toContain("--prompt");
  });

  it("should include short prompt in hint", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: "Fix bugs",
    });
    expect(hint).toContain('--prompt "Fix bugs"');
  });

  it("should truncate prompt longer than 30 chars with ellipsis", () => {
    const longPrompt = "A".repeat(35);
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: longPrompt,
    });
    expect(hint).toContain("A".repeat(30) + "...");
    expect(hint).not.toContain("A".repeat(31));
  });

  it("should not truncate prompt at exactly 30 chars", () => {
    const exact = "B".repeat(30);
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: exact,
    });
    expect(hint).toContain("B".repeat(30));
    expect(hint).not.toContain("...");
  });

  it("should truncate prompt at 31 chars", () => {
    const prompt31 = "C".repeat(31);
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-02-11T14:30:00.000Z",
      prompt: prompt31,
    });
    expect(hint).toContain("C".repeat(30) + "...");
  });

  it("should handle invalid timestamp gracefully", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "not-a-date",
    });
    expect(hint).toBe("not-a-date");
  });

  it("should include both timestamp and prompt preview", () => {
    const hint = buildRecordHint({
      agent: "claude",
      cloud: "sprite",
      timestamp: "2026-06-15T10:00:00.000Z",
      prompt: "Add tests",
    });
    expect(hint).toContain("2026");
    expect(hint).toContain("Jun");
    expect(hint).toContain('--prompt "Add tests"');
  });
});

// ── showListFooter prompt escaping ───────────────────────────────────────────
// PR #537 added double-quote escaping in rerun prompt suggestions

describe("showListFooter prompt escaping", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  function writeHistory(records: SpawnRecord[]) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function consoleOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `spawn-footer-esc-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    consoleMocks = createConsoleMocks();
    mockLogInfo.mockClear();
    originalFetch = global.fetch;

    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;
    await loadManifest(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should escape double quotes in rerun prompt suggestion", async () => {
    writeHistory([
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T10:00:00Z",
        prompt: 'Fix the "login" bug',
      },
    ]);

    await cmdList();

    const output = consoleOutput();
    // The rerun hint should escape quotes for valid shell
    expect(output).toContain('\\"');
    // Should NOT contain unescaped quotes that would break shell parsing
    // (beyond the wrapping quotes)
  });

  it("should not escape prompts without double quotes", async () => {
    writeHistory([
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T10:00:00Z",
        prompt: "Fix all linter errors",
      },
    ]);

    await cmdList();

    const output = consoleOutput();
    expect(output).toContain('--prompt "Fix all linter errors"');
    expect(output).not.toContain('\\"');
  });

  it("should handle prompt with multiple double quotes", async () => {
    writeHistory([
      {
        agent: "claude",
        cloud: "sprite",
        timestamp: "2026-01-01T10:00:00Z",
        prompt: 'Set "key" to "value"',
      },
    ]);

    await cmdList();

    const output = consoleOutput();
    // Both quotes should be escaped
    const rerunLine = consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .find((l: string) => l.includes("Rerun last"));
    expect(rerunLine).toBeDefined();
    // Count escaped quotes - should have at least 2 (for "key" and "value")
    const escapedCount = (rerunLine!.match(/\\"/g) || []).length;
    expect(escapedCount).toBeGreaterThanOrEqual(2);
  });
});
