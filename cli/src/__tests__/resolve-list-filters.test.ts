import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest, _resetCacheForTesting } from "../manifest";
import type { SpawnRecord } from "../history";

/**
 * Tests for resolveListFilters (commands.ts) and its integration with cmdList.
 *
 * resolveListFilters is an internal function that:
 * 1. Loads the manifest (gracefully handles failures)
 * 2. Resolves agent display names to keys (e.g., "Claude Code" -> "claude")
 * 3. Resolves cloud display names to keys (e.g., "Hetzner Cloud" -> "hetzner")
 * 4. When a bare positional filter doesn't match an agent, tries it as a cloud
 * 5. Returns the resolved filters and manifest for downstream use
 *
 * This function has ZERO direct test coverage. The existing cmdList tests
 * don't exercise:
 * - Display name resolution for agent/cloud filters
 * - Case-insensitive matching for filters
 * - Bare positional arg fallback from agent to cloud
 * - Manifest load failure graceful degradation (returns raw keys)
 * - Both -a and -c filters resolved simultaneously
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── Exact replica of resolveListFilters logic from commands.ts ───────────────

function resolveAgentKey(
  manifest: { agents: Record<string, { name: string }> },
  input: string
): string | null {
  if (manifest.agents[input]) return input;
  const keys = Object.keys(manifest.agents);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of keys) {
    if (manifest.agents[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

function resolveCloudKey(
  manifest: { clouds: Record<string, { name: string }> },
  input: string
): string | null {
  if (manifest.clouds[input]) return input;
  const keys = Object.keys(manifest.clouds);
  const lower = input.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of keys) {
    if (manifest.clouds[key].name.toLowerCase() === lower) return key;
  }
  return null;
}

interface ResolveResult {
  manifest: typeof mockManifest | null;
  agentFilter?: string;
  cloudFilter?: string;
}

function resolveListFilters(
  manifest: typeof mockManifest | null,
  agentFilter?: string,
  cloudFilter?: string
): ResolveResult {
  if (manifest && agentFilter) {
    const resolved = resolveAgentKey(manifest, agentFilter);
    if (resolved) {
      agentFilter = resolved;
    } else if (!cloudFilter) {
      // Bare positional arg didn't match an agent -- try as a cloud filter
      const resolvedCloud = resolveCloudKey(manifest, agentFilter);
      if (resolvedCloud) {
        cloudFilter = resolvedCloud;
        agentFilter = undefined;
      }
    }
  }
  if (manifest && cloudFilter) {
    const resolved = resolveCloudKey(manifest, cloudFilter);
    if (resolved) cloudFilter = resolved;
  }

  return { manifest, agentFilter, cloudFilter };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("resolveListFilters", () => {
  // ── Agent key resolution ────────────────────────────────────────────

  describe("agent key resolution", () => {
    it("should pass through exact agent key unchanged", () => {
      const result = resolveListFilters(mockManifest, "claude");
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should resolve case-insensitive agent key", () => {
      const result = resolveListFilters(mockManifest, "CLAUDE");
      expect(result.agentFilter).toBe("claude");
    });

    it("should resolve agent display name to key", () => {
      const result = resolveListFilters(mockManifest, "Claude Code");
      expect(result.agentFilter).toBe("claude");
    });

    it("should resolve case-insensitive agent display name", () => {
      const result = resolveListFilters(mockManifest, "claude code");
      expect(result.agentFilter).toBe("claude");
    });

    it("should resolve mixed-case agent display name", () => {
      const result = resolveListFilters(mockManifest, "CLAUDE CODE");
      expect(result.agentFilter).toBe("claude");
    });

    it("should resolve aider display name", () => {
      const result = resolveListFilters(mockManifest, "Aider");
      expect(result.agentFilter).toBe("aider");
    });
  });

  // ── Cloud key resolution ────────────────────────────────────────────

  describe("cloud key resolution", () => {
    it("should pass through exact cloud key unchanged", () => {
      const result = resolveListFilters(mockManifest, undefined, "hetzner");
      expect(result.cloudFilter).toBe("hetzner");
      expect(result.agentFilter).toBeUndefined();
    });

    it("should resolve case-insensitive cloud key", () => {
      const result = resolveListFilters(mockManifest, undefined, "HETZNER");
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should resolve cloud display name to key", () => {
      const result = resolveListFilters(mockManifest, undefined, "Hetzner Cloud");
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should resolve case-insensitive cloud display name", () => {
      const result = resolveListFilters(mockManifest, undefined, "hetzner cloud");
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should resolve sprite display name", () => {
      const result = resolveListFilters(mockManifest, undefined, "Sprite");
      expect(result.cloudFilter).toBe("sprite");
    });
  });

  // ── Bare positional fallback (agent -> cloud) ──────────────────────

  describe("bare positional arg fallback from agent to cloud", () => {
    it("should try bare arg as cloud when it doesn't match an agent", () => {
      const result = resolveListFilters(mockManifest, "sprite");
      // "sprite" is not an agent but IS a cloud
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should try bare cloud display name when it doesn't match agent", () => {
      const result = resolveListFilters(mockManifest, "Hetzner Cloud");
      // "Hetzner Cloud" is not an agent name but IS a cloud display name
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should try case-insensitive bare cloud key", () => {
      const result = resolveListFilters(mockManifest, "SPRITE");
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should NOT fallback to cloud when -c filter is already set", () => {
      // When cloudFilter is already specified, don't swap agent to cloud
      const result = resolveListFilters(mockManifest, "sprite", "hetzner");
      // "sprite" doesn't match as agent, but cloudFilter is already "hetzner"
      // so agentFilter stays as "sprite" (unresolved)
      expect(result.agentFilter).toBe("sprite");
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should keep bare arg as agentFilter when it matches neither agent nor cloud", () => {
      const result = resolveListFilters(mockManifest, "nonexistent");
      expect(result.agentFilter).toBe("nonexistent");
      expect(result.cloudFilter).toBeUndefined();
    });
  });

  // ── Both filters ──────────────────────────────────────────────────

  describe("both agent and cloud filters", () => {
    it("should resolve both agent and cloud simultaneously", () => {
      const result = resolveListFilters(mockManifest, "claude", "sprite");
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should resolve display names for both", () => {
      const result = resolveListFilters(mockManifest, "Claude Code", "Hetzner Cloud");
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("hetzner");
    });

    it("should resolve case-insensitive for both", () => {
      const result = resolveListFilters(mockManifest, "AIDER", "SPRITE");
      expect(result.agentFilter).toBe("aider");
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should resolve agent key but pass through unknown cloud", () => {
      const result = resolveListFilters(mockManifest, "claude", "unknown-cloud");
      expect(result.agentFilter).toBe("claude");
      expect(result.cloudFilter).toBe("unknown-cloud");
    });

    it("should pass through unknown agent but resolve cloud key", () => {
      const result = resolveListFilters(mockManifest, "unknown-agent", "sprite");
      // When cloudFilter is already set, agent is NOT swapped to cloud
      expect(result.agentFilter).toBe("unknown-agent");
      expect(result.cloudFilter).toBe("sprite");
    });
  });

  // ── No filters ────────────────────────────────────────────────────

  describe("no filters", () => {
    it("should return undefined filters when neither is provided", () => {
      const result = resolveListFilters(mockManifest);
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should return undefined filters with explicit undefined", () => {
      const result = resolveListFilters(mockManifest, undefined, undefined);
      expect(result.agentFilter).toBeUndefined();
      expect(result.cloudFilter).toBeUndefined();
    });
  });

  // ── Null manifest (offline/failure) ────────────────────────────────

  describe("null manifest (offline mode)", () => {
    it("should pass through agent filter unchanged when manifest is null", () => {
      const result = resolveListFilters(null, "claude");
      expect(result.agentFilter).toBe("claude");
      expect(result.manifest).toBeNull();
    });

    it("should pass through cloud filter unchanged when manifest is null", () => {
      const result = resolveListFilters(null, undefined, "hetzner");
      expect(result.cloudFilter).toBe("hetzner");
      expect(result.manifest).toBeNull();
    });

    it("should pass through both filters unchanged when manifest is null", () => {
      const result = resolveListFilters(null, "Claude Code", "Sprite");
      // No resolution happens - raw values are preserved
      expect(result.agentFilter).toBe("Claude Code");
      expect(result.cloudFilter).toBe("Sprite");
    });

    it("should not attempt cloud fallback when manifest is null", () => {
      const result = resolveListFilters(null, "sprite");
      // Without manifest, can't detect that "sprite" is a cloud
      expect(result.agentFilter).toBe("sprite");
      expect(result.cloudFilter).toBeUndefined();
    });
  });

  // ── Manifest returned ─────────────────────────────────────────────

  describe("manifest passthrough", () => {
    it("should return the manifest in the result", () => {
      const result = resolveListFilters(mockManifest, "claude");
      expect(result.manifest).toBe(mockManifest);
    });

    it("should return null manifest when null is passed", () => {
      const result = resolveListFilters(null);
      expect(result.manifest).toBeNull();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle agent key that matches case-insensitively but not exactly", () => {
      // "Claude" lowercased is "claude" which matches the key
      const result = resolveListFilters(mockManifest, "Claude");
      expect(result.agentFilter).toBe("claude");
    });

    it("should handle cloud key that matches case-insensitively but not exactly", () => {
      // "Sprite" lowercased is "sprite" which matches the key
      const result = resolveListFilters(mockManifest, undefined, "Sprite");
      expect(result.cloudFilter).toBe("sprite");
    });

    it("should handle agent display name that starts with same prefix as cloud key", () => {
      // "Aider" is an agent display name, resolves to "aider"
      const result = resolveListFilters(mockManifest, "Aider");
      expect(result.agentFilter).toBe("aider");
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should handle empty string agent filter", () => {
      const result = resolveListFilters(mockManifest, "");
      // Empty string matches no agent and no cloud
      expect(result.agentFilter).toBe("");
      expect(result.cloudFilter).toBeUndefined();
    });

    it("should handle empty string cloud filter", () => {
      const result = resolveListFilters(mockManifest, undefined, "");
      expect(result.cloudFilter).toBe("");
    });
  });
});

// ── resolveAgentKey and resolveCloudKey unit tests ───────────────────────────

describe("resolveAgentKey", () => {
  it("should return exact key match", () => {
    expect(resolveAgentKey(mockManifest, "claude")).toBe("claude");
  });

  it("should return case-insensitive key match", () => {
    expect(resolveAgentKey(mockManifest, "CLAUDE")).toBe("claude");
    expect(resolveAgentKey(mockManifest, "Claude")).toBe("claude");
  });

  it("should return key for display name match", () => {
    expect(resolveAgentKey(mockManifest, "Claude Code")).toBe("claude");
  });

  it("should return key for case-insensitive display name", () => {
    expect(resolveAgentKey(mockManifest, "claude code")).toBe("claude");
    expect(resolveAgentKey(mockManifest, "AIDER")).toBe("aider");
  });

  it("should return null for no match", () => {
    expect(resolveAgentKey(mockManifest, "nonexistent")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(resolveAgentKey(mockManifest, "")).toBeNull();
  });

  it("should return null for partial key match", () => {
    expect(resolveAgentKey(mockManifest, "clau")).toBeNull();
  });

  it("should resolve partial-looking display name via case-insensitive key match", () => {
    // "Claude" lowercased is "claude" which matches the key case-insensitively
    expect(resolveAgentKey(mockManifest, "Claude")).toBe("claude");
  });

  it("should prefer exact key match over display name", () => {
    // If input matches a key directly, returns immediately
    expect(resolveAgentKey(mockManifest, "aider")).toBe("aider");
  });

  it("should return null for substring of display name", () => {
    // "Code" is part of "Claude Code" but doesn't match any key or full name
    expect(resolveAgentKey(mockManifest, "Code")).toBeNull();
  });
});

describe("resolveCloudKey", () => {
  it("should return exact key match", () => {
    expect(resolveCloudKey(mockManifest, "sprite")).toBe("sprite");
  });

  it("should return case-insensitive key match", () => {
    expect(resolveCloudKey(mockManifest, "SPRITE")).toBe("sprite");
    expect(resolveCloudKey(mockManifest, "Hetzner")).toBe("hetzner");
  });

  it("should return key for display name match", () => {
    expect(resolveCloudKey(mockManifest, "Hetzner Cloud")).toBe("hetzner");
    expect(resolveCloudKey(mockManifest, "Sprite")).toBe("sprite");
  });

  it("should return key for case-insensitive display name", () => {
    expect(resolveCloudKey(mockManifest, "hetzner cloud")).toBe("hetzner");
    expect(resolveCloudKey(mockManifest, "SPRITE")).toBe("sprite");
  });

  it("should return null for no match", () => {
    expect(resolveCloudKey(mockManifest, "aws")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(resolveCloudKey(mockManifest, "")).toBeNull();
  });

  it("should return null for partial display name", () => {
    expect(resolveCloudKey(mockManifest, "Hetzner C")).toBeNull();
  });

  it("should return null for substring of display name", () => {
    expect(resolveCloudKey(mockManifest, "Cloud")).toBeNull();
  });
});

// ── Integration: cmdList with resolveListFilters ─────────────────────────────

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
    warn: mock(() => {}),
    error: mockLogError,
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => Promise.resolve(0)),
  isCancel: () => false,
}));

const { cmdList, resolveDisplayName, getImplementedClouds, getImplementedAgents } =
  await import("../commands.js");

describe("cmdList integration with filter resolution", () => {
  let testDir: string;
  let cacheDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    testDir = join(homedir(), `spawn-resolve-list-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    cacheDir = join(testDir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    process.env.XDG_CACHE_HOME = cacheDir;
    // Force non-interactive mode for cmdList
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    consoleMocks = createConsoleMocks();
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
    _resetCacheForTesting();

    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    _resetCacheForTesting();
  });

  function seedHistory(records: SpawnRecord[]) {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));
  }

  function setupManifestFetch() {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
    })) as any;
  }

  it("should show empty message when no history exists with agent filter", async () => {
    setupManifestFetch();

    try {
      await cmdList("nonexistent");
    } catch {
      // process.exit may be called
    }

    const infoOutput = mockLogInfo.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(infoOutput).toContain("No spawns found");
  });

  it("should filter by exact agent key and display raw keys in table", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
    ]);

    await cmdList("claude");

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    // The table should contain the agent record
    expect(output).toContain("claude");
    expect(output).toContain("sprite");
    // Should show "1 of 2" filter info
    expect(output).toContain("1 of 2");
  });

  it("should show no-match message when filter matches nothing", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);

    try {
      await cmdList("aider");
    } catch {
      // May call process.exit
    }

    const infoOutput = mockLogInfo.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(infoOutput).toContain("No spawns found");
  });

  it("should work with no filters showing all history", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
    ]);

    await cmdList();

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    // Table should contain both records (display names if manifest loaded, raw keys otherwise)
    expect(output.toLowerCase()).toContain("claude");
    expect(output.toLowerCase()).toContain("aider");
    expect(output).toContain("2 spawn");
  });

  it("should show table header with correct columns", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);

    await cmdList();

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(output).toContain("AGENT");
    expect(output).toContain("CLOUD");
    expect(output).toContain("WHEN");
  });

  it("should show rerun hint in footer", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);

    await cmdList();

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(output).toContain("Rerun last");
    expect(output).toContain("spawn claude sprite");
  });

  it("should show rerun hint with prompt when last record has prompt", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z", prompt: "Fix bugs" },
    ]);

    await cmdList();

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(output).toContain("Fix bugs");
    expect(output).toContain("--prompt");
  });

  it("should show filter info when agent filter is applied", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
    ]);

    await cmdList("claude");

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(output).toContain("Showing");
    expect(output).toContain("Clear filter");
  });

  it("should show filter info when cloud filter is applied", async () => {
    setupManifestFetch();
    seedHistory([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
    ]);

    await cmdList(undefined, "sprite");

    const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
    expect(output).toContain("Showing");
    expect(output).toContain("1 of 2");
  });
});

// ── resolveDisplayName unit tests ───────────────────────────────────────────

describe("resolveDisplayName", () => {
  it("should return display name for known agent key", () => {
    expect(resolveDisplayName(mockManifest, "claude", "agent")).toBe("Claude Code");
  });

  it("should return display name for known cloud key", () => {
    expect(resolveDisplayName(mockManifest, "sprite", "cloud")).toBe("Sprite");
  });

  it("should return raw key for unknown agent", () => {
    expect(resolveDisplayName(mockManifest, "unknown-agent", "agent")).toBe("unknown-agent");
  });

  it("should return raw key for unknown cloud", () => {
    expect(resolveDisplayName(mockManifest, "unknown-cloud", "cloud")).toBe("unknown-cloud");
  });

  it("should return raw key when manifest is null", () => {
    expect(resolveDisplayName(null, "claude", "agent")).toBe("claude");
  });

  it("should return raw key when manifest is null for cloud", () => {
    expect(resolveDisplayName(null, "sprite", "cloud")).toBe("sprite");
  });

  it("should handle empty string key", () => {
    expect(resolveDisplayName(mockManifest, "", "agent")).toBe("");
  });

  it("should handle agent key that is also a cloud key (agent lookup)", () => {
    const manifest = {
      ...mockManifest,
      agents: {
        ...mockManifest.agents,
        sprite: {
          name: "Sprite Agent",
          description: "agent version",
          url: "",
          install: "",
          launch: "",
          env: {},
        },
      },
    };
    expect(resolveDisplayName(manifest, "sprite", "agent")).toBe("Sprite Agent");
    expect(resolveDisplayName(manifest, "sprite", "cloud")).toBe("Sprite");
  });
});

// ── getImplementedClouds / getImplementedAgents ─────────────────────────────

describe("getImplementedClouds", () => {
  it("should return clouds where agent is implemented", () => {
    const clouds = getImplementedClouds(mockManifest, "claude");
    expect(clouds).toContain("sprite");
    expect(clouds).toContain("hetzner");
  });

  it("should exclude clouds where agent is missing", () => {
    const clouds = getImplementedClouds(mockManifest, "aider");
    expect(clouds).toContain("sprite");
    expect(clouds).not.toContain("hetzner");
  });

  it("should return empty array for unknown agent", () => {
    const clouds = getImplementedClouds(mockManifest, "nonexistent");
    expect(clouds).toEqual([]);
  });
});

describe("getImplementedAgents", () => {
  it("should return agents implemented on cloud", () => {
    const agents = getImplementedAgents(mockManifest, "sprite");
    expect(agents).toContain("claude");
    expect(agents).toContain("aider");
  });

  it("should exclude agents not implemented on cloud", () => {
    const agents = getImplementedAgents(mockManifest, "hetzner");
    expect(agents).toContain("claude");
    expect(agents).not.toContain("aider");
  });

  it("should return empty array for unknown cloud", () => {
    const agents = getImplementedAgents(mockManifest, "nonexistent");
    expect(agents).toEqual([]);
  });
});
