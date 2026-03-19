/**
 * cmd-fix-cov.test.ts — Additional coverage for commands/fix.ts
 *
 * Covers paths not exercised in cmd-fix.test.ts:
 * - fixSpawn with security validation failures for server_id/server_name
 * - fixSpawn loading manifest from network when it fails
 * - cmdFix non-interactive mode with multiple servers
 * - cmdFix with interactive picker (select + cancel)
 */

import type { SpawnRecord } from "../history";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryCatch } from "@openrouter/spawn-shared";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const CANCEL_SYMBOL = Symbol("cancel");
const selectValue: unknown = "test-id-1";
const clack = mockClackPrompts({
  select: mock(async () => selectValue),
  isCancel: (val: unknown) => val === CANCEL_SYMBOL,
});

// ── Import modules under test ───────────────────────────────────────────────
const { fixSpawn, cmdFix } = await import("../commands/fix.js");
const { _resetCacheForTesting } = await import("../manifest.js");

// ── Helpers ────────────────────────────────────────────────────────────────

const mockManifest = createMockManifest();

function makeRecord(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return {
    id: "test-id-1",
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

// ── Tests: fixSpawn edge cases ──────────────────────────────────────────────

describe("fixSpawn (additional coverage)", () => {
  beforeEach(() => {
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    clack.logSuccess.mockReset();
    clack.logStep.mockReset();
  });

  it("shows error for invalid server_name in connection", async () => {
    const record = makeRecord({
      connection: {
        ip: "1.2.3.4",
        user: "root",
        server_name: "$(inject)",
        cloud: "hetzner",
      },
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Security validation"));
  });

  it("shows error for invalid server_id in connection", async () => {
    const record = makeRecord({
      connection: {
        ip: "1.2.3.4",
        user: "root",
        server_id: "$(inject)",
        cloud: "hetzner",
      },
    });
    await fixSpawn(record, mockManifest);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Security validation"));
  });

  it("shows error when manifest load fails and no manifest provided", async () => {
    const record = makeRecord();
    const savedFetch = global.fetch;

    // Clear the manifest cache and set up failing fetch
    _resetCacheForTesting();
    // Also clear any cached manifest file
    const { rmSync: rm } = await import("node:fs");
    const { getCacheFile } = await import("../shared/paths.js");
    tryCatch(() => rm(getCacheFile()));

    global.fetch = mock(
      async () =>
        new Response("server error", {
          status: 500,
        }),
    );

    await fixSpawn(record, null);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Failed to load manifest"));

    global.fetch = savedFetch;
  });

  it("uses record name for label when server_name is absent", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord({
      name: "custom-name",
      connection: {
        ip: "1.2.3.4",
        user: "root",
        cloud: "hetzner",
      },
    });
    await fixSpawn(record, mockManifest, {
      runScript: mockRunner,
    });
    expect(clack.logStep).toHaveBeenCalledWith(expect.stringContaining("custom-name"));
  });

  it("uses IP for label when no name or server_name", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord({
      name: undefined,
      connection: {
        ip: "1.2.3.4",
        user: "root",
        cloud: "hetzner",
      },
    });
    await fixSpawn(record, mockManifest, {
      runScript: mockRunner,
    });
    expect(clack.logStep).toHaveBeenCalledWith(expect.stringContaining("1.2.3.4"));
  });
});

// ── Tests: cmdFix edge cases ─────────────────────────────────────────────────

describe("cmdFix (additional coverage)", () => {
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
    testDir = join(process.env.HOME ?? "", `spawn-fix-cov-${Date.now()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;

    clack.logError.mockReset();
    clack.logInfo.mockReset();
    clack.logSuccess.mockReset();

    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();

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

  it("shows non-interactive error when multiple servers and no TTY", async () => {
    writeHistory([
      makeRecord({
        id: "id-1",
      }),
      makeRecord({
        id: "id-2",
        name: "other-spawn",
      }),
    ]);

    await cmdFix();

    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("interactive terminal"));
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("spawn fix <spawn-id>"));
  });

  it("fixes directly when only one server (no picker needed)", async () => {
    const mockRunner = mock(async () => true);
    writeHistory([
      makeRecord({
        id: "only-one",
      }),
    ]);

    const savedFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();

    await cmdFix(undefined, {
      runScript: mockRunner,
    });

    expect(mockRunner).toHaveBeenCalled();
    global.fetch = savedFetch;
  });
});
