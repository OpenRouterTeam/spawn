/**
 * cmd-fix-cov.test.ts — Additional coverage for commands/fix.ts
 *
 * Covers paths not exercised in cmd-fix.test.ts:
 * - fixSpawn with security validation failures for server_id/server_name
 * - fixSpawn loading manifest from network when it fails
 * - fixSpawn label fallbacks (record name, IP)
 * - fixSpawn success message
 */

import type { SpawnRecord } from "../history";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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
const { fixSpawn } = await import("../commands/fix.js");
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
  let savedApiKey: string | undefined;

  beforeEach(() => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test-fix-key";
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    clack.logSuccess.mockReset();
    clack.logStep.mockReset();
  });

  afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = savedApiKey;
    }
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

  it("shows success when fix script succeeds", async () => {
    const mockRunner = mock(async () => true);
    const record = makeRecord();
    await fixSpawn(record, mockManifest, {
      runScript: mockRunner,
    });
    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("fixed successfully"));
  });
});
