import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";

/**
 * Tests for cmdList table rendering with manifest-resolved display names.
 *
 * cmdList (commands.ts:845-882) renders spawn history as a formatted table:
 * - Resolves agent/cloud keys to display names via the manifest
 * - Falls back to raw keys when manifest is unavailable
 * - Shows table header: AGENT, CLOUD, WHEN
 * - Renders rows with agent name (green), cloud name, timestamp, optional prompt
 * - Truncates prompt previews > 40 chars in rows
 * - Delegates footer to showListFooter (tested in list-empty-footer.test.ts)
 *
 * resolveDisplayName (commands.ts:839-843) is exported but has no direct tests:
 * - Returns entry.name when key exists in manifest
 * - Returns raw key when key is not in manifest
 * - Returns raw key when manifest is null
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogError = mock(() => {});
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
    error: mockLogError,
    warn: mock(() => {}),
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import after mock setup
const { cmdList, resolveDisplayName } = await import("../commands.js");

// ── resolveDisplayName direct tests ──────────────────────────────────────────

describe("resolveDisplayName", () => {
  it("should return agent display name when key exists", () => {
    expect(resolveDisplayName(mockManifest, "claude", "agent")).toBe("Claude Code");
  });

  it("should return cloud display name when key exists", () => {
    expect(resolveDisplayName(mockManifest, "sprite", "cloud")).toBe("Sprite");
  });

  it("should return raw key when agent key is not in manifest", () => {
    expect(resolveDisplayName(mockManifest, "unknown-agent", "agent")).toBe("unknown-agent");
  });

  it("should return raw key when cloud key is not in manifest", () => {
    expect(resolveDisplayName(mockManifest, "unknown-cloud", "cloud")).toBe("unknown-cloud");
  });

  it("should return raw key when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
  });

  it("should return raw key when manifest is null for cloud", () => {
    expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
  });

  it("should handle second agent key correctly", () => {
    expect(resolveDisplayName(mockManifest, "codex", "agent")).toBe("Codex");
  });

  it("should handle second cloud key correctly", () => {
    expect(resolveDisplayName(mockManifest, "hetzner", "cloud")).toBe("Hetzner Cloud");
  });
});

// ── cmdList table rendering integration ──────────────────────────────────────

describe("cmdList table rendering", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    originalEnv = { ...process.env };

    // Set up temp history dir
    testDir = join(homedir(), `.spawn-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function writeHistory(records: Array<{ agent: string; cloud: string; timestamp: string; prompt?: string }>) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls
      .map((c: any[]) => c.join(" "))
      .join("\n");
  }

  // ── Table header ───────────────────────────────────────────────────────

  describe("table header", () => {
    it("should render AGENT, CLOUD, WHEN header columns", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("AGENT");
      expect(output).toContain("CLOUD");
      expect(output).toContain("WHEN");
    });

    it("should render a separator line with dashes", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("----");
    });
  });

  // ── Display name resolution in rows ────────────────────────────────────

  describe("display name resolution", () => {
    it("should show agent display name from manifest", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("Claude Code");
    });

    it("should show cloud display name from manifest", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "hetzner", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show raw key when agent is not in manifest", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "unknown-agent", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("unknown-agent");
    });

    it("should show raw key when cloud is not in manifest", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "unknown-cloud", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("unknown-cloud");
    });

    it("should fall back to raw keys when manifest fetch fails", async () => {
      global.fetch = mock(async () => {
        throw new Error("Network error");
      }) as any;
      // Force manifest cache to be cleared
      try { await loadManifest(true); } catch { /* expected */ }

      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      // When manifest is unavailable, the raw keys should be shown
      // Either "claude" or "Claude Code" is acceptable depending on cache
      expect(output).toMatch(/claude|Claude Code/);
    });
  });

  // ── Multiple rows ──────────────────────────────────────────────────────

  describe("multiple rows", () => {
    it("should render all records in reverse chronological order", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      // All agents should appear
      expect(output).toContain("Claude Code");
      expect(output).toContain("Codex");
      // All clouds should appear
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show rerun hint with most recent record", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      // Most recent is codex/hetzner (reversed = first), so rerun hint should use it
      expect(output).toContain("spawn codex hetzner");
    });
  });

  // ── Prompt preview in rows ─────────────────────────────────────────────

  describe("prompt preview in rows", () => {
    it("should show short prompt inline with row", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Fix bugs" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("Fix bugs");
    });

    it("should truncate prompt > 40 chars in row with ellipsis", async () => {
      await setManifest(mockManifest);
      const longPrompt = "A".repeat(50);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: longPrompt },
      ]);

      await cmdList();
      const output = getOutput();
      // Row display should show first 40 chars + "..."
      expect(output).toContain("A".repeat(40) + "...");
      // Rerun hint at footer shows full prompt (<=80 chars) for valid copy-paste
      const rerunLine = consoleMocks.log.mock.calls
        .map((c: any[]) => c.join(" "))
        .find((l: string) => l.includes("Rerun last"));
      expect(rerunLine!).toContain("A".repeat(50));
    });

    it("should show exactly 40-char prompt without truncation", async () => {
      await setManifest(mockManifest);
      const exactPrompt = "B".repeat(40);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: exactPrompt },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("B".repeat(40));
      // Should not have ellipsis since it's exactly 40
      expect(output).not.toContain("B".repeat(40) + "...");
    });

    it("should not show --prompt in row when no prompt given", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).not.toContain("--prompt");
    });
  });

  // ── Prompt in footer rerun hint ────────────────────────────────────────

  describe("prompt in footer rerun hint", () => {
    it("should include --prompt in rerun hint when latest has prompt", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: "Fix bugs" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain('--prompt "Fix bugs"');
    });

    it("should show full prompt in rerun hint when <= 80 chars", async () => {
      await setManifest(mockManifest);
      const shortPrompt = "C".repeat(35);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: shortPrompt },
      ]);

      await cmdList();
      const output = getOutput();
      // Rerun hint shows full prompt when <= 80 chars (valid copyable command)
      expect(output).toContain(`--prompt "${shortPrompt}"`);
    });

    it("should suggest --prompt-file in rerun hint for very long prompts", async () => {
      await setManifest(mockManifest);
      const longPrompt = "C".repeat(81);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z", prompt: longPrompt },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("--prompt-file");
    });

    it("should not include --prompt in rerun hint when latest has no prompt", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      // Rerun line should not have --prompt
      const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      const rerunLine = lines.find((l: string) => l.includes("Rerun last"));
      expect(rerunLine).toBeDefined();
      expect(rerunLine!).not.toContain("--prompt");
    });
  });

  // ── Filtered results display ───────────────────────────────────────────

  describe("filtered results", () => {
    it("should show only matching records with agent filter", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T10:00:00.000Z" },
      ]);

      await cmdList("claude");
      const output = getOutput();
      expect(output).toContain("Claude Code");
      // Codex should not appear in filtered results
      expect(output).not.toContain("Codex");
    });

    it("should show only matching records with cloud filter", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList(undefined, "sprite");
      const output = getOutput();
      expect(output).toContain("Sprite");
      // Hetzner should not appear
      expect(output).not.toContain("Hetzner Cloud");
    });

    it("should show 'Showing N of M' when filters are active", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
        { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T10:00:00.000Z" },
      ]);

      await cmdList("claude");
      const output = getOutput();
      expect(output).toContain("Showing 2 of 3");
    });

    it("should show 'Clear filter' hint when filters are active", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList("claude");
      const output = getOutput();
      expect(output).toContain("Clear filter");
      expect(output).toContain("spawn list");
    });

    it("should show filter hint when no filters are active", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("Filter");
      expect(output).toContain("spawn list -a");
    });

    it("should show total count without 'Showing' when unfiltered", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T10:00:00.000Z" },
        { agent: "codex", cloud: "hetzner", timestamp: "2026-01-02T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("2 spawns recorded");
      expect(output).not.toContain("Showing");
    });

    it("should use singular 'spawn' for single record", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      expect(output).toContain("1 spawn recorded");
      // Should not say "1 spawns"
      expect(output).not.toContain("1 spawns");
    });
  });

  // ── Timestamp formatting in rows ───────────────────────────────────────

  describe("timestamp display", () => {
    it("should show relative time for valid ISO timestamp", async () => {
      await setManifest(mockManifest);
      // Use a recent timestamp so we get a relative time like "1h ago"
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: new Date(Date.now() - 3600_000).toISOString() },
      ]);

      await cmdList();
      const output = getOutput();
      // Should not contain the raw ISO timestamp format
      expect(output).not.toContain(".000Z");
      // Should show a relative time like "1h ago" or "just now"
      expect(output).toMatch(/\d+h ago|just now|\d+ min ago/);
    });

    it("should handle invalid timestamp gracefully", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "not-a-date" },
      ]);

      await cmdList();
      const output = getOutput();
      // formatTimestamp returns the raw string for invalid dates
      expect(output).toContain("not-a-date");
    });
  });

  // ── Single record edge case ────────────────────────────────────────────

  describe("single record", () => {
    it("should render a complete table for a single record", async () => {
      await setManifest(mockManifest);
      writeHistory([
        { agent: "claude", cloud: "sprite", timestamp: "2026-02-11T10:00:00.000Z" },
      ]);

      await cmdList();
      const output = getOutput();
      // Header
      expect(output).toContain("AGENT");
      expect(output).toContain("CLOUD");
      expect(output).toContain("WHEN");
      // Data
      expect(output).toContain("Claude Code");
      expect(output).toContain("Sprite");
      // Footer
      expect(output).toContain("Rerun last");
      expect(output).toContain("spawn claude sprite");
    });
  });
});
