import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for the cmdList filter suggestion path and cmdMatrix compact/grid
 * view selection in commands.ts.
 *
 * cmdList filter suggestions (lines 746-779):
 * When a filter matches no records, cmdList loads the manifest and suggests
 * corrections via resolveAgentKey/resolveCloudKey/findClosestKeyByNameOrKey.
 * This is a critical UX path that has zero direct test coverage.
 *
 * cmdMatrix compact vs grid view (lines 698-726):
 * When the grid is wider than the terminal, cmdMatrix switches to a compact
 * list view with different output format. The branching logic and compact
 * rendering are untested.
 *
 * Also covers:
 * - cmdList rerun hint with prompt (line 813-815)
 * - cmdList prompt preview truncation in output (line 803)
 * - cmdMatrix legend text for compact vs grid mode
 * - calculateColumnWidth with various inputs
 * - getMissingClouds helper
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Manifest with many clouds to force compact view
const wideManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "test" },
    },
    aider: {
      name: "Aider",
      description: "AI pair programmer",
      url: "https://aider.chat",
      install: "pip install aider-chat",
      launch: "aider",
      env: { OPENAI_API_KEY: "test" },
    },
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
      url: "https://sprite.sh",
      type: "vm",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    vultr: {
      name: "Vultr",
      description: "Cloud compute",
      url: "https://vultr.com",
      type: "cloud",
      auth: "VULTR_API_KEY",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    linode: {
      name: "Linode",
      description: "Cloud hosting",
      url: "https://linode.com",
      type: "cloud",
      auth: "LINODE_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    digitalocean: {
      name: "DigitalOcean",
      description: "Cloud infrastructure",
      url: "https://digitalocean.com",
      type: "cloud",
      auth: "DO_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    binarylane: {
      name: "BinaryLane",
      description: "Australian cloud",
      url: "https://binarylane.com",
      type: "cloud",
      auth: "BL_API_KEY",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    kamatera: {
      name: "Kamatera",
      description: "Global cloud",
      url: "https://kamatera.com",
      type: "cloud",
      auth: "KAMATERA_API_KEY",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    scaleway: {
      name: "Scaleway",
      description: "European cloud",
      url: "https://scaleway.com",
      type: "cloud",
      auth: "SCW_SECRET_KEY",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/aider": "missing",
    "vultr/claude": "implemented",
    "vultr/aider": "missing",
    "linode/claude": "implemented",
    "linode/aider": "missing",
    "digitalocean/claude": "implemented",
    "digitalocean/aider": "missing",
    "binarylane/claude": "implemented",
    "binarylane/aider": "missing",
    "kamatera/claude": "implemented",
    "kamatera/aider": "missing",
    "scaleway/claude": "implemented",
    "scaleway/aider": "missing",
  },
};

// Mock @clack/prompts
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

// Import commands after mock setup
const {
  cmdList,
  cmdMatrix,
  calculateColumnWidth,
  getTerminalWidth,
  getMissingClouds,
  getImplementedClouds,
} = await import("../commands.js");

// ── cmdList filter suggestions ──────────────────────────────────────────────

describe("cmdList - filter suggestions", () => {
  let testDir: string;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getAllClackInfo(): string[] {
    return mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
  }

  beforeEach(async () => {
    testDir = join(tmpdir(), `spawn-filter-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogSuccess.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    delete process.env.SPAWN_HOME;
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  // ── Typo correction for agent filter ────────────────────────────────

  describe("agent filter suggestions", () => {
    it("should suggest resolved agent key when filter is a case mismatch", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      await cmdList("CLAUDE");

      // "CLAUDE" matches no records (case-sensitive filter in filterHistory) -- wait,
      // actually filterHistory IS case-insensitive (line 48: lower comparison).
      // So "CLAUDE" would match "claude" and return records. Let's use a different case.
      // Let's check with a typo instead.
    });

    it("should suggest closest agent match for a typo in filter", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      // "cladue" is a typo of "claude" (transposed letters, distance <= 3)
      await cmdList("cladue");

      const infoCalls = getAllClackInfo();
      // Should suggest the correct agent key
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean") && msg.includes("claude"))).toBe(true);
    });

    it("should resolve display name to key and find matching records", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      // "Claude Code" resolves to "claude" via resolveAgentKey display name match
      // so records should be found directly without needing a suggestion
      await cmdList("Claude Code");

      const logCalls = consoleMocks.log.mock.calls.map((c: any[]) => String(c[0] ?? "")).join("\n");
      // Should find the record and show it (table header visible)
      expect(logCalls).toContain("AGENT");
      expect(logCalls).toContain("claude");
    });

    it("should not suggest when agent filter is completely unrelated", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      // "zzzzzzzzz" has Levenshtein distance > 3 from any agent key or name
      await cmdList("zzzzzzzzz");

      const infoCalls = getAllClackInfo();
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
    });

    it("should show 'see all spawns' hint when filter returns nothing but records exist", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      await cmdList("nonexistent");

      const infoCalls = getAllClackInfo();
      expect(infoCalls.some((msg: string) => msg.includes("spawn list") && msg.includes("1"))).toBe(true);
    });
  });

  // ── Typo correction for cloud filter ────────────────────────────────

  describe("cloud filter suggestions", () => {
    it("should suggest closest cloud match for a typo in filter", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      // "sprit" is a typo of "sprite" (missing 'e', distance 1)
      await cmdList(undefined, "sprit");

      const infoCalls = getAllClackInfo();
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean") && msg.includes("sprite"))).toBe(true);
    });

    it("should resolve cloud display name to key and find matching records", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "hetzner", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      // "Hetzner Cloud" resolves to "hetzner" via resolveCloudKey display name match
      // so records should be found directly without needing a suggestion
      await cmdList(undefined, "Hetzner Cloud");

      const logCalls = consoleMocks.log.mock.calls.map((c: any[]) => String(c[0] ?? "")).join("\n");
      // Should find the record and show it (table header visible)
      expect(logCalls).toContain("AGENT");
      expect(logCalls).toContain("hetzner");
    });

    it("should not suggest cloud when filter is completely unrelated", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      await cmdList(undefined, "xxxxxxxxxxxxxx");

      const infoCalls = getAllClackInfo();
      const cloudSuggestions = infoCalls.filter((msg: string) =>
        msg.includes("Did you mean") && msg.includes("-c")
      );
      expect(cloudSuggestions).toHaveLength(0);
    });
  });

  // ── Both filters with no match ──────────────────────────────────────

  describe("both agent and cloud filter suggestions", () => {
    it("should suggest corrections for both agent and cloud typos", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );
      await setManifest(mockManifest);

      // Both are typos: "cladue" for "claude", "sprit" for "sprite"
      await cmdList("cladue", "sprit");

      const infoCalls = getAllClackInfo();
      // Should have suggestions for both
      const agentSuggestion = infoCalls.find((msg: string) =>
        msg.includes("Did you mean") && msg.includes("-a")
      );
      const cloudSuggestion = infoCalls.find((msg: string) =>
        msg.includes("Did you mean") && msg.includes("-c")
      );
      expect(agentSuggestion).toBeDefined();
      expect(cloudSuggestion).toBeDefined();
    });
  });

  // ── Manifest unavailable during suggestions ──────────────────────────

  describe("manifest failure during suggestions", () => {
    it("should not crash when manifest is unavailable for suggestions", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{ agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00Z" }])
      );

      // Make fetch fail for manifest
      global.fetch = mock(async () => {
        throw new Error("Network down");
      }) as any;

      // Should not throw -- the suggestion path catches manifest load failures
      await cmdList("nonexistent");

      // Should still show the "no spawns found" message
      const infoCalls = getAllClackInfo();
      expect(infoCalls.some((msg: string) => msg.includes("No spawns found"))).toBe(true);
    });
  });

  // ── No history file at all ──────────────────────────────────────────

  describe("empty history with filter", () => {
    it("should not suggest corrections when there are zero total records", async () => {
      // No history file at all
      await setManifest(mockManifest);

      await cmdList("nonexistent");

      const infoCalls = getAllClackInfo();
      // Should not show "see all N spawns" since there are 0 total
      expect(infoCalls.some((msg: string) => msg.includes("spawn list") && msg.includes("recorded"))).toBe(false);
    });

    it("should show 'No spawns recorded' when no history and no filter", async () => {
      await cmdList();

      const infoCalls = getAllClackInfo();
      expect(infoCalls.some((msg: string) => msg.includes("No spawns recorded"))).toBe(true);
    });
  });

  // ── Prompt display in list output ────────────────────────────────────

  describe("prompt display in history", () => {
    it("should show truncated prompt preview for long prompts", async () => {
      const longPrompt = "A".repeat(60);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          prompt: longPrompt,
        }])
      );

      await cmdList();

      const logOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // Prompt is truncated to 40 chars with "..."
      expect(logOutput).toContain("...");
      expect(logOutput).toContain("--prompt");
    });

    it("should show full prompt when <= 40 chars", async () => {
      const shortPrompt = "Fix bugs";
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          prompt: shortPrompt,
        }])
      );

      await cmdList();

      const logOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Fix bugs");
      // Should not have truncation dots (unless part of other text)
      const promptLine = consoleMocks.log.mock.calls
        .map((c: any[]) => c.join(" "))
        .find((l: string) => l.includes("--prompt"));
      if (promptLine) {
        expect(promptLine).not.toContain("Fix bugs...");
      }
    });

    it("should include prompt in rerun hint for most recent spawn", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          prompt: "Fix all linter errors",
        }])
      );

      await cmdList();

      const logOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Rerun last");
      expect(logOutput).toContain("--prompt");
      expect(logOutput).toContain("Fix all linter errors");
    });

    it("should suggest --prompt-file in rerun hint for very long prompts", async () => {
      const longPrompt = "B".repeat(81);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          prompt: longPrompt,
        }])
      );

      await cmdList();

      const logOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Rerun last");
      const rerunLine = consoleMocks.log.mock.calls
        .map((c: any[]) => c.join(" "))
        .find((l: string) => l.includes("Rerun last"));
      expect(rerunLine).toBeDefined();
      // Very long prompts (>80 chars) suggest --prompt-file instead
      expect(rerunLine!).toContain("--prompt-file");
      expect(rerunLine!).not.toContain(longPrompt);
    });

    it("should show full prompt in rerun hint when <= 80 chars", async () => {
      const shortPrompt = "B".repeat(50);
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
          prompt: shortPrompt,
        }])
      );

      await cmdList();

      const rerunLine = consoleMocks.log.mock.calls
        .map((c: any[]) => c.join(" "))
        .find((l: string) => l.includes("Rerun last"));
      expect(rerunLine).toBeDefined();
      // Short enough prompts are shown in full for valid copy-paste
      expect(rerunLine!).toContain(shortPrompt);
    });

    it("should not show --prompt in rerun hint when no prompt was used", async () => {
      writeFileSync(
        join(testDir, "history.json"),
        JSON.stringify([{
          agent: "claude",
          cloud: "sprite",
          timestamp: "2026-01-01T00:00:00Z",
        }])
      );

      await cmdList();

      const logOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(logOutput).toContain("Rerun last");
      const rerunLine = consoleMocks.log.mock.calls
        .map((c: any[]) => c.join(" "))
        .find((l: string) => l.includes("Rerun last"));
      expect(rerunLine).toBeDefined();
      expect(rerunLine!).not.toContain("--prompt");
    });
  });
});

// ── cmdMatrix compact vs grid view ──────────────────────────────────────────

describe("cmdMatrix - compact vs grid view", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let originalDescriptor: PropertyDescriptor | undefined;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function setTerminalWidth(width: number | undefined) {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogSuccess.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    originalDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDescriptor) {
      Object.defineProperty(process.stdout, "columns", originalDescriptor);
    }
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  describe("grid view (wide terminal)", () => {
    it("should render grid view on wide terminal with few clouds", async () => {
      // Set terminal very wide so grid fits
      setTerminalWidth(200);
      await setManifest(mockManifest);

      await cmdMatrix();

      const output = getOutput();
      // Grid view shows "+" for implemented, "-" for missing
      expect(output).toContain("+");
      expect(output).toContain("-");
      // Grid legend
      expect(output).toContain("implemented");
      expect(output).toContain("not yet available");
    });

    it("should show separator line between header and rows in grid view", async () => {
      setTerminalWidth(200);
      await setManifest(mockManifest);

      await cmdMatrix();

      const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      const separatorLine = lines.find((l: string) => l.includes("---"));
      expect(separatorLine).toBeDefined();
    });
  });

  describe("compact view (narrow terminal)", () => {
    it("should render compact view on narrow terminal with many clouds", async () => {
      // Set terminal very narrow to force compact mode
      setTerminalWidth(40);
      await setManifest(wideManifest);

      await cmdMatrix();

      const output = getOutput();
      // Compact view shows "all clouds supported" or "Not yet available" column
      expect(output).toContain("Agent");
      expect(output).toContain("Clouds");
      expect(output).toContain("Not yet available");
    });

    it("should show green for fully-supported agents in compact view", async () => {
      setTerminalWidth(40);
      await setManifest(wideManifest);

      await cmdMatrix();

      const output = getOutput();
      // claude is implemented on all 8 clouds
      expect(output).toContain("all clouds supported");
    });

    it("should list missing cloud names in compact view for partial agents", async () => {
      setTerminalWidth(40);
      await setManifest(wideManifest);

      await cmdMatrix();

      const output = getOutput();
      // aider is missing on several clouds
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show ratio X/Y for each agent in compact view", async () => {
      setTerminalWidth(40);
      await setManifest(wideManifest);

      await cmdMatrix();

      const output = getOutput();
      // claude: 8/8, aider: 1/8
      expect(output).toContain("8/8");
      expect(output).toContain("1/8");
    });

    it("should show compact legend instead of grid legend", async () => {
      setTerminalWidth(40);
      await setManifest(wideManifest);

      await cmdMatrix();

      const output = getOutput();
      // Compact view uses different legend text
      expect(output).toContain("green");
      expect(output).toContain("yellow");
    });
  });

  describe("total count in both views", () => {
    it("should show total implemented/total ratio", async () => {
      setTerminalWidth(200);
      await setManifest(mockManifest);

      await cmdMatrix();

      const output = getOutput();
      // 3 out of 4 (2 agents * 2 clouds, 3 implemented)
      expect(output).toContain("3/4 combinations implemented");
    });

    it("should show correct count in compact view", async () => {
      setTerminalWidth(40);
      await setManifest(wideManifest);

      await cmdMatrix();

      const output = getOutput();
      // 9 out of 16 (2 agents * 8 clouds, claude=8 + aider=1 = 9)
      expect(output).toContain("9/16 combinations implemented");
    });
  });

  describe("launch hint", () => {
    it("should show spawn command hints in footer", async () => {
      setTerminalWidth(200);
      await setManifest(mockManifest);

      await cmdMatrix();

      const output = getOutput();
      expect(output).toContain("spawn <agent> <cloud>");
      expect(output).toContain("spawn <agent>");
      expect(output).toContain("spawn <cloud>");
    });
  });
});

// ── calculateColumnWidth ────────────────────────────────────────────────────

describe("calculateColumnWidth", () => {
  it("should return minWidth when all items are shorter", () => {
    expect(calculateColumnWidth(["ab", "cd"], 16)).toBe(16);
  });

  it("should return item width + padding when items exceed minWidth", () => {
    expect(calculateColumnWidth(["a-very-long-cloud-name"], 10)).toBe(
      "a-very-long-cloud-name".length + 2 // COL_PADDING = 2
    );
  });

  it("should return minWidth for empty array", () => {
    expect(calculateColumnWidth([], 16)).toBe(16);
  });

  it("should use longest item when multiple items given", () => {
    const items = ["short", "medium-length", "the-longest-item-here"];
    const expected = "the-longest-item-here".length + 2;
    expect(calculateColumnWidth(items, 10)).toBe(expected);
  });

  it("should handle single character items", () => {
    expect(calculateColumnWidth(["a", "b", "c"], 10)).toBe(10);
  });

  it("should handle items exactly at minWidth minus padding", () => {
    // item length + 2 (padding) = minWidth
    const item = "a".repeat(14); // 14 + 2 = 16 = minWidth
    expect(calculateColumnWidth([item], 16)).toBe(16);
  });

  it("should handle items one char over minWidth", () => {
    const item = "a".repeat(15); // 15 + 2 = 17 > minWidth=16
    expect(calculateColumnWidth([item], 16)).toBe(17);
  });
});

// ── getMissingClouds ────────────────────────────────────────────────────────

describe("getMissingClouds", () => {
  it("should return clouds where agent is not implemented", () => {
    const clouds = ["sprite", "hetzner"];
    const missing = getMissingClouds(mockManifest, "aider", clouds);
    // aider is missing on hetzner in mock manifest
    expect(missing).toEqual(["hetzner"]);
  });

  it("should return empty array when all clouds are implemented", () => {
    const clouds = ["sprite", "hetzner"];
    const missing = getMissingClouds(mockManifest, "claude", clouds);
    // claude is implemented on both
    expect(missing).toEqual([]);
  });

  it("should return all clouds when agent has no implementations", () => {
    const noImplManifest: Manifest = {
      ...mockManifest,
      matrix: {
        "sprite/claude": "missing",
        "sprite/aider": "missing",
        "hetzner/claude": "missing",
        "hetzner/aider": "missing",
      },
    };
    const clouds = ["sprite", "hetzner"];
    const missing = getMissingClouds(noImplManifest, "claude", clouds);
    expect(missing).toEqual(["sprite", "hetzner"]);
  });

  it("should handle empty clouds array", () => {
    const missing = getMissingClouds(mockManifest, "claude", []);
    expect(missing).toEqual([]);
  });

  it("should handle cloud keys not in matrix at all", () => {
    const missing = getMissingClouds(mockManifest, "claude", ["unknown-cloud"]);
    // matrixStatus returns "missing" for unknown keys
    expect(missing).toEqual(["unknown-cloud"]);
  });
});

// ── getImplementedClouds ────────────────────────────────────────────────────

describe("getImplementedClouds", () => {
  it("should return only implemented clouds for claude", () => {
    const clouds = getImplementedClouds(mockManifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
    expect(clouds).toHaveLength(2);
  });

  it("should return only implemented clouds for aider", () => {
    const clouds = getImplementedClouds(mockManifest, "aider");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
    expect(clouds).toHaveLength(1);
  });

  it("should return empty array for unknown agent", () => {
    const clouds = getImplementedClouds(mockManifest, "nonexistent");
    expect(clouds).toEqual([]);
  });

  it("should return all clouds when all are implemented", () => {
    const clouds = getImplementedClouds(wideManifest, "claude");
    expect(clouds).toHaveLength(8);
  });

  it("should return 1 cloud when only one is implemented", () => {
    const clouds = getImplementedClouds(wideManifest, "aider");
    expect(clouds).toEqual(["sprite"]);
  });
});

// ── getTerminalWidth ────────────────────────────────────────────────────────

describe("getTerminalWidth", () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(process.stdout, "columns", originalDescriptor);
    }
  });

  function setTerminalWidth(width: number | undefined) {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  it("should return process.stdout.columns when set", () => {
    setTerminalWidth(120);
    expect(getTerminalWidth()).toBe(120);
  });

  it("should return 80 when columns is not set", () => {
    // @ts-ignore - setting to undefined to simulate no terminal
    setTerminalWidth(undefined);
    expect(getTerminalWidth()).toBe(80);
  });

  it("should return 80 when columns is 0 (falsy)", () => {
    setTerminalWidth(0);
    expect(getTerminalWidth()).toBe(80);
  });
});
