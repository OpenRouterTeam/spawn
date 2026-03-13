/**
 * cmd-fix.test.ts — Tests for the `spawn fix` command.
 *
 * Uses DI (options.runScript) instead of mock.module for SSH execution
 * to avoid process-global mock pollution (pattern from delete-spinner.test.ts).
 */

import type { SpawnRecord } from "../history";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock (must be at module top level) ───────────────────────
const clack = mockClackPrompts();

// ── Import modules under test (no mock.module for core modules) ────────────
const { buildFixScript, fixSpawn, cmdFix } = await import("../commands/fix.js");
const { loadManifest, _resetCacheForTesting } = await import("../manifest.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return {
    id: "test-id-123",
    agent: "claude",
    cloud: "hetzner",
    timestamp: new Date().toISOString(),
    name: "my-spawn",
    connection: {
      ip: "1.2.3.4",
      user: "root",
      server_name: "spawn-abc",
      server_id: "12345",
      cloud: "hetzner",
    },
    ...overrides,
  };
}

const mockManifest = createMockManifest();

// ── Test Setup ─────────────────────────────────────────────────────────────

describe("buildFixScript", () => {
  it("generates a script with env re-injection and install command", () => {
    const script = buildFixScript(mockManifest, "claude");

    expect(script).toContain("set -eo pipefail");
    expect(script).toContain("Re-injecting credentials");
    expect(script).toContain("ANTHROPIC_API_KEY");
    expect(script).toContain("~/.spawnrc");
    expect(script).toContain("Re-installing agent");
    expect(script).toContain("npm install -g claude");
    expect(script).toContain("Done! Your spawn is ready.");
    expect(script).toContain("claude"); // launch command hint
  });

  it("resolves ${VAR} template references from process.env", () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    const manifest = {
      ...mockManifest,
      agents: {
        ...mockManifest.agents,
        claude: {
          ...mockManifest.agents.claude,
          env: {
            OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
          },
        },
      },
    };
    const script = buildFixScript(manifest, "claude");
    // Restore before asserting (even though test will continue)
    if (savedKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = savedKey;
    }
    expect(script).toContain("sk-or-test-key");
  });

  it("handles agents without install command", () => {
    const manifest = {
      ...mockManifest,
      agents: {
        claude: {
          name: "Claude Code",
          description: "AI coding assistant",
          url: "https://claude.ai",
          launch: "claude",
          env: {
            ANTHROPIC_API_KEY: "test-key",
          },
        },
      },
    };
    const script = buildFixScript(manifest, "claude");

    expect(script).not.toContain("Re-installing agent");
    expect(script).toContain("Re-injecting credentials");
    expect(script).toContain("Done!");
  });

  it("handles agents without env vars", () => {
    const manifest = {
      ...mockManifest,
      agents: {
        claude: {
          name: "Claude Code",
          description: "AI coding assistant",
          url: "https://claude.ai",
          install: "npm install -g claude",
          launch: "claude",
        },
      },
    };
    const script = buildFixScript(manifest, "claude");

    expect(script).not.toContain(".spawnrc");
    expect(script).toContain("Re-installing agent");
  });

  it("throws for unknown agent", () => {
    expect(() => buildFixScript(mockManifest, "unknown-agent")).toThrow("Unknown agent: unknown-agent");
  });

  it("shell-escapes single quotes in env var values", () => {
    const manifest = {
      ...mockManifest,
      agents: {
        claude: {
          name: "Claude Code",
          description: "AI coding assistant",
          url: "https://claude.ai",
          launch: "claude",
          env: {
            API_KEY: "it's-a-key",
          },
        },
      },
    };
    const script = buildFixScript(manifest, "claude");
    // Single quote in value should be escaped as '\''
    expect(script).toContain("it'\\''s-a-key");
  });
});

// ── Tests: fixSpawn (DI for SSH runner) ─────────────────────────────────────

describe("fixSpawn", () => {
  beforeEach(() => {
    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logInfo.mockReset();
    clack.logStep.mockReset();
  });

  it("shows error for record without connection info", async () => {
    const record = makeRecord({
      connection: undefined,
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("no connection information"));
  });

  it("shows error for deleted server", async () => {
    const record = makeRecord({
      connection: {
        ip: "1.2.3.4",
        user: "root",
        deleted: true,
      },
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("deleted"));
  });

  it("shows error for sprite-console connections", async () => {
    const record = makeRecord({
      connection: {
        ip: "sprite-console",
        user: "root",
        server_name: "my-sprite",
      },
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Sprite console"));
  });

  it("shows error for unknown agent", async () => {
    const record = makeRecord({
      agent: "nonexistent",
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Unknown agent"));
  });

  it("calls the script runner with correct args on success", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      runScript: mockRunner,
    });

    expect(mockRunner).toHaveBeenCalledWith("1.2.3.4", "root", expect.stringContaining("set -eo pipefail"), []);
    expect(clack.logSuccess).toHaveBeenCalled();
  });

  it("shows error when runner returns false", async () => {
    const mockRunner = mock(async () => false);
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      runScript: mockRunner,
    });

    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("error"));
  });

  it("shows error when runner throws", async () => {
    const mockRunner = mock(async () => {
      throw new Error("SSH failed");
    });
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      runScript: mockRunner,
    });

    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Fix failed"));
  });

  it("loads manifest from network if not provided", async () => {
    const record = makeRecord();
    const mockRunner = mock(async () => true);

    // Prime manifest cache with test data
    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await fixSpawn(record, null, {
      runScript: mockRunner,
    });

    expect(clack.logSuccess).toHaveBeenCalled();
  });
});

// ── Tests: cmdFix (reads real history file, DI for SSH) ─────────────────────

describe("cmdFix", () => {
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let processExitSpy: ReturnType<typeof spyOn>;

  function writeHistory(records: SpawnRecord[]) {
    writeFileSync(
      join(testDir, "history.json"),
      JSON.stringify({
        version: 1,
        records,
      }),
    );
  }

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `spawn-fix-test-${Date.now()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;
    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logInfo.mockReset();
    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    process.env.SPAWN_HOME = savedSpawnHome;
    processExitSpy.mockRestore();
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    }
  });

  it("shows message when no active spawns", async () => {
    // No history file written — empty history
    await cmdFix();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active spawns"));
  });

  it("fixes by spawn ID when passed as argument", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord({
      id: "my-spawn-id",
    });
    writeHistory([
      record,
    ]);

    // Prime manifest cache
    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await cmdFix("my-spawn-id", {
      runScript: mockRunner,
    });

    expect(mockRunner).toHaveBeenCalled();
  });

  it("fixes by spawn name", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord({
      name: "my-named-spawn",
    });
    writeHistory([
      record,
    ]);

    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await cmdFix("my-named-spawn", {
      runScript: mockRunner,
    });

    expect(mockRunner).toHaveBeenCalled();
  });

  it("fixes by server_name", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord({
      connection: {
        ip: "1.2.3.4",
        user: "root",
        server_name: "spawn-xyz",
        cloud: "hetzner",
      },
    });
    writeHistory([
      record,
    ]);

    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await cmdFix("spawn-xyz", {
      runScript: mockRunner,
    });

    expect(mockRunner).toHaveBeenCalled();
  });

  it("shows error when spawn ID not found", async () => {
    const record = makeRecord({
      id: "other-id",
    });
    writeHistory([
      record,
    ]);

    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await cmdFix("nonexistent-id");

    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("directly fixes when only one active server exists (no picker)", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord();
    writeHistory([
      record,
    ]);

    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await cmdFix(undefined, {
      runScript: mockRunner,
    });

    expect(mockRunner).toHaveBeenCalled();
  });
});
