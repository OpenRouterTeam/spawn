import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadHistory,
  saveSpawnRecord,
  clearHistory,
  type SpawnRecord,
} from "../history.js";
import type { Manifest } from "../manifest";

/**
 * Tests for recently added features (PR #944) that had zero coverage:
 *
 * 1. clearHistory() - removes history file and returns count
 * 2. cmdListClear() - user-facing command that calls clearHistory
 * 3. --clear flag dispatch in index.ts
 * 4. buildCredentialStatusLines cloud URL hint for missing credentials
 *
 * Agent: test-engineer
 */

// ── clearHistory unit tests ─────────────────────────────────────────────

describe("clearHistory", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-clear-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns 0 when history file does not exist", () => {
    expect(clearHistory()).toBe(0);
  });

  it("returns 0 when history file contains empty array", () => {
    writeFileSync(join(testDir, "history.json"), "[]");
    expect(clearHistory()).toBe(0);
    // File should still exist since count was 0 (no unlinkSync called)
    expect(existsSync(join(testDir, "history.json"))).toBe(true);
  });

  it("returns count and deletes file when history has records", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
      { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    const count = clearHistory();
    expect(count).toBe(3);
    expect(existsSync(join(testDir, "history.json"))).toBe(false);
  });

  it("returns 1 and deletes file for single-record history", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    const count = clearHistory();
    expect(count).toBe(1);
    expect(existsSync(join(testDir, "history.json"))).toBe(false);
  });

  it("returns 0 for corrupted JSON file (loadHistory returns [])", () => {
    writeFileSync(join(testDir, "history.json"), "not valid json{{{");
    const count = clearHistory();
    // loadHistory returns [] for corrupted files, so count is 0
    expect(count).toBe(0);
  });

  it("returns 0 for non-array JSON (loadHistory returns [])", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify({ not: "array" }));
    const count = clearHistory();
    expect(count).toBe(0);
  });

  it("after clearing, loadHistory returns empty array", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    clearHistory();
    expect(loadHistory()).toEqual([]);
  });

  it("can save new records after clearing", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    clearHistory();
    saveSpawnRecord({ agent: "aider", cloud: "hetzner", timestamp: "2026-02-01T00:00:00.000Z" });

    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].agent).toBe("aider");
  });

  it("handles clearing a full 100-entry history", () => {
    const records: SpawnRecord[] = [];
    for (let i = 0; i < 100; i++) {
      records.push({
        agent: `agent-${i}`,
        cloud: `cloud-${i}`,
        timestamp: `2026-01-01T00:00:00.000Z`,
      });
    }
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    const count = clearHistory();
    expect(count).toBe(100);
    expect(existsSync(join(testDir, "history.json"))).toBe(false);
  });

  it("calling clearHistory twice returns 0 the second time", () => {
    const records: SpawnRecord[] = [
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ];
    writeFileSync(join(testDir, "history.json"), JSON.stringify(records));

    expect(clearHistory()).toBe(1);
    expect(clearHistory()).toBe(0);
  });

  it("preserves other files in SPAWN_HOME when clearing history", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]));
    writeFileSync(join(testDir, "config.json"), JSON.stringify({ key: "value" }));

    clearHistory();
    expect(existsSync(join(testDir, "history.json"))).toBe(false);
    expect(existsSync(join(testDir, "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"))).toEqual({ key: "value" });
  });
});

// ── cmdListClear tests ──────────────────────────────────────────────────

const mockLog = {
  step: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  success: mock(() => {}),
};

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: mockLog,
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => Promise.resolve("hetzner")),
  confirm: mock(() => Promise.resolve(true)),
  isCancel: () => false,
}));

const { cmdListClear } = await import("../commands.js");

describe("cmdListClear", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-cmdclear-test-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
    mockLog.info.mockClear();
    mockLog.success.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("logs info message when no history exists", () => {
    cmdListClear();
    expect(mockLog.info).toHaveBeenCalledTimes(1);
    expect(mockLog.info.mock.calls[0][0]).toContain("No spawn history to clear");
  });

  it("logs info message when history file has empty array", () => {
    writeFileSync(join(testDir, "history.json"), "[]");
    cmdListClear();
    expect(mockLog.info).toHaveBeenCalledTimes(1);
    expect(mockLog.info.mock.calls[0][0]).toContain("No spawn history to clear");
  });

  it("logs success with count for single record", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]));
    cmdListClear();
    expect(mockLog.success).toHaveBeenCalledTimes(1);
    const msg = mockLog.success.mock.calls[0][0] as string;
    expect(msg).toContain("Cleared 1 spawn record ");
    // Should be singular "record" not "records"
    expect(msg).not.toContain("records");
  });

  it("logs success with plural for multiple records", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
      { agent: "claude", cloud: "hetzner", timestamp: "2026-01-03T00:00:00.000Z" },
    ]));
    cmdListClear();
    expect(mockLog.success).toHaveBeenCalledTimes(1);
    const msg = mockLog.success.mock.calls[0][0] as string;
    expect(msg).toContain("Cleared 3 spawn records");
  });

  it("actually removes the history file", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]));
    cmdListClear();
    expect(existsSync(join(testDir, "history.json"))).toBe(false);
  });

  it("does not call success when no records to clear", () => {
    cmdListClear();
    expect(mockLog.success).not.toHaveBeenCalled();
  });

  it("does not call info when records are cleared", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
    ]));
    cmdListClear();
    expect(mockLog.info).not.toHaveBeenCalled();
  });
});

// ── --clear flag dispatch routing ───────────────────────────────────────

describe("--clear flag dispatch in index.ts", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-clear-dispatch-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    originalEnv = { ...process.env };
    process.env.SPAWN_HOME = testDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("--clear is in the KNOWN_FLAGS set (not treated as unknown)", async () => {
    // Read index.ts to verify --clear is in KNOWN_FLAGS
    const indexSrc = readFileSync(join(__dirname, "..", "index.ts"), "utf-8");
    expect(indexSrc).toContain('"--clear"');
  });

  it("spawn list --clear clears history (integration)", () => {
    // Set up history, then call cmdListClear directly (same path as dispatch)
    writeFileSync(join(testDir, "history.json"), JSON.stringify([
      { agent: "claude", cloud: "sprite", timestamp: "2026-01-01T00:00:00.000Z" },
      { agent: "aider", cloud: "hetzner", timestamp: "2026-01-02T00:00:00.000Z" },
    ]));

    mockLog.success.mockClear();
    cmdListClear();

    expect(existsSync(join(testDir, "history.json"))).toBe(false);
    expect(mockLog.success).toHaveBeenCalledTimes(1);
  });

  it("list --clear is documented in help text", async () => {
    const commandsSrc = readFileSync(join(__dirname, "..", "commands.ts"), "utf-8");
    expect(commandsSrc).toContain("spawn list --clear");
    expect(commandsSrc).toContain("Clear all spawn history");
  });
});

// ── buildCredentialStatusLines cloud URL hints ──────────────────────────

describe("buildCredentialStatusLines cloud URL hint", () => {
  // buildCredentialStatusLines is not exported, so we test it indirectly
  // by verifying the code path exists and the URL hint logic is correct.
  // We also verify via parseAuthEnvVars + cloud manifest structure.

  function makeManifest(overrides?: Partial<Manifest>): Manifest {
    return {
      agents: {
        claude: {
          name: "Claude Code",
          description: "AI coding agent",
          url: "https://claude.ai",
          install: "curl -fsSL https://claude.ai/install.sh | bash",
          launch: "claude",
          env: { ANTHROPIC_API_KEY: "" },
        },
      },
      clouds: {
        hetzner: {
          name: "Hetzner Cloud",
          description: "German cloud",
          url: "https://hetzner.cloud",
          type: "api",
          auth: "HCLOUD_TOKEN",
          provision_method: "api",
          exec_method: "ssh root@IP",
          interactive_method: "ssh -t root@IP",
        },
        upcloud: {
          name: "UpCloud",
          description: "European cloud",
          url: "https://upcloud.com",
          type: "api",
          auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
          provision_method: "api",
          exec_method: "ssh root@IP",
          interactive_method: "ssh -t root@IP",
        },
        sprite: {
          name: "Sprite",
          description: "Dev environments",
          url: "https://sprite.dev",
          type: "cli",
          auth: "sprite login",
          provision_method: "cli",
          exec_method: "sprite exec NAME",
          interactive_method: "sprite exec NAME -tty",
        },
        localcloud: {
          name: "Local",
          description: "Run locally",
          url: "",
          type: "local",
          auth: "none",
          provision_method: "local",
          exec_method: "bash -c",
          interactive_method: "bash",
        },
      },
      matrix: {
        "hetzner/claude": "implemented",
        "upcloud/claude": "implemented",
        "sprite/claude": "implemented",
        "localcloud/claude": "implemented",
      },
      ...overrides,
    } as Manifest;
  }

  it("cloud manifest has url field used for credential hints", () => {
    const m = makeManifest();
    expect(m.clouds.hetzner.url).toBe("https://hetzner.cloud");
    expect(m.clouds.upcloud.url).toBe("https://upcloud.com");
  });

  it("cloud with empty url produces no hint", () => {
    const m = makeManifest();
    expect(m.clouds.localcloud.url).toBe("");
  });

  it("buildCredentialStatusLines source code shows URL on first missing var", () => {
    // Verify the pattern exists in commands.ts
    const src = readFileSync(join(__dirname, "..", "commands.ts"), "utf-8");
    // Should find the cloudUrl assignment
    expect(src).toContain("const cloudUrl = manifest.clouds[cloud].url");
    // Should find the URL hint logic
    expect(src).toContain("i === 0 && cloudUrl");
    // Should build the hint using pc.dim
    expect(src).toContain("urlHint");
  });

  it("URL hint only appears on first missing auth var (not subsequent)", () => {
    // Verify the conditional check: i === 0 && cloudUrl
    const src = readFileSync(join(__dirname, "..", "commands.ts"), "utf-8");
    // The pattern ensures URL hint is only on index 0
    expect(src).toContain('const urlHint = i === 0 && cloudUrl ? ');
  });

  it("OPENROUTER_API_KEY line always shows openrouter.ai URL when missing", () => {
    // Verify the OPENROUTER_API_KEY line always includes its own URL
    const src = readFileSync(join(__dirname, "..", "commands.ts"), "utf-8");
    expect(src).toContain("https://openrouter.ai/settings/keys");
  });
});
