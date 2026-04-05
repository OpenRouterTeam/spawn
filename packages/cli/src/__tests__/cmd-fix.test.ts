/**
 * cmd-fix.test.ts — Tests for the `spawn fix` command.
 *
 * Uses DI (options.makeRunner) instead of mock.module for SSH execution
 * to avoid process-global mock pollution (pattern from delete-spinner.test.ts).
 */

import type { SpawnRecord } from "../history";
import type { CloudRunner } from "../shared/agent-setup";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock (must be at module top level) ───────────────────────
const clack = mockClackPrompts();

// ── Import modules under test (no mock.module for core modules) ────────────
const { fixSpawn, cmdFix } = await import("../commands/fix.js");
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

/** Create a mock CloudRunner that records all commands. */
function makeMockRunner(): {
  runner: CloudRunner;
  commands: string[];
  uploads: Array<{
    local: string;
    remote: string;
  }>;
} {
  const commands: string[] = [];
  const uploads: Array<{
    local: string;
    remote: string;
  }> = [];
  const runner: CloudRunner = {
    runServer: mock(async (cmd: string) => {
      commands.push(cmd);
    }),
    uploadFile: mock(async (local: string, remote: string) => {
      uploads.push({
        local,
        remote,
      });
    }),
    downloadFile: mock(async () => {}),
  };
  return {
    runner,
    commands,
    uploads,
  };
}

// ── Tests: fixSpawn (DI for CloudRunner) ──────────────────────────────────

describe("fixSpawn", () => {
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-fix-key";
    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logInfo.mockReset();
    clack.logStep.mockReset();
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = savedApiKey;
    }
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

  it("shows security error for agent name with shell metacharacters", async () => {
    const record = makeRecord({
      agent: "claude;rm -rf /",
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Security validation failed"));
  });

  it("runs all fix phases via CloudRunner on success", async () => {
    const mockState = makeMockRunner();
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      makeRunner: () => mockState.runner,
    });

    // Should have called runServer multiple times (env injection, install, configure, verify, etc.)
    expect(mockState.runner.runServer).toHaveBeenCalled();
    expect(clack.logSuccess).toHaveBeenCalled();
  });

  it("injects env vars via CloudRunner", async () => {
    const mockState = makeMockRunner();
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      makeRunner: () => mockState.runner,
    });

    // First runServer call should be the env injection (base64-encoded .spawnrc + rc sourcing)
    const envCmd = mockState.commands.find((c) => c.includes("spawnrc"));
    expect(envCmd).toBeTruthy();
  });

  it("verifies agent binary is in PATH", async () => {
    const mockState = makeMockRunner();
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      makeRunner: () => mockState.runner,
    });

    // Should have a command -v check for the agent binary
    const verifyCmd = mockState.commands.find((c) => c.includes("command -v"));
    expect(verifyCmd).toBeTruthy();
    expect(verifyCmd).toContain("claude");
  });

  it("continues when install fails (non-fatal)", async () => {
    const mockState = makeMockRunner();
    // Make install calls fail but allow others to succeed
    mockState.runner.runServer = mock(async (cmd: string) => {
      mockState.commands.push(cmd);
      // Fail on install-related commands but succeed on env injection and verify
      if (cmd.includes("npm install") || cmd.includes("curl")) {
        throw new Error("install failed");
      }
    });
    const record = makeRecord();

    await fixSpawn(record, mockManifest, {
      makeRunner: () => mockState.runner,
    });

    // Should still complete — install errors are non-fatal
    expect(clack.logSuccess).toHaveBeenCalled();
  });

  it("loads manifest from network if not provided", async () => {
    const mockState = makeMockRunner();
    const record = makeRecord();

    // Prime manifest cache with test data
    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();
    await loadManifest(true);
    global.fetch = savedFetch;

    await fixSpawn(record, null, {
      makeRunner: () => mockState.runner,
    });

    expect(clack.logSuccess).toHaveBeenCalled();
  });
});

// ── Tests: cmdFix (reads real history file, DI for CloudRunner) ───────────

describe("cmdFix", () => {
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let savedApiKey: string | undefined;
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
    savedApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-fix-key";
    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logInfo.mockReset();
    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    process.env.SPAWN_HOME = savedSpawnHome;
    if (savedApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = savedApiKey;
    }
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
    const mockState = makeMockRunner();
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
      makeRunner: () => mockState.runner,
    });

    expect(mockState.runner.runServer).toHaveBeenCalled();
  });

  it("fixes by spawn name", async () => {
    const mockState = makeMockRunner();
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
      makeRunner: () => mockState.runner,
    });

    expect(mockState.runner.runServer).toHaveBeenCalled();
  });

  it("fixes by server_name", async () => {
    const mockState = makeMockRunner();
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
      makeRunner: () => mockState.runner,
    });

    expect(mockState.runner.runServer).toHaveBeenCalled();
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

    await expect(cmdFix("nonexistent-id")).rejects.toThrow("process.exit");

    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("not found"));
  });

  it("directly fixes when only one active server exists (no picker)", async () => {
    const mockState = makeMockRunner();
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
      makeRunner: () => mockState.runner,
    });

    expect(mockState.runner.runServer).toHaveBeenCalled();
  });
});
