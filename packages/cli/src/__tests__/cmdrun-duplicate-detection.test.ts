import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../manifest";
import { isString } from "../shared/type-guards";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

/**
 * Tests for the --name duplicate detection feature (issue #1864).
 *
 * When `spawn <agent> <cloud> --name "foo"` is run and an active instance named
 * "foo" already exists for that agent + cloud, cmdRun should route the user into
 * the existing-instance picker (handleRecordAction) rather than blindly
 * provisioning a new VM.
 *
 * Agent: issue-fixer
 */

const mockManifest = createMockManifest();

// ── Clack mock refs ──────────────────────────────────────────────────────────

// select returns "rerun" to exercise the "Spawn a new VM" path
const mockSelect = mock(async () => "rerun");

const {
  logWarn: mockLogWarn,
  logStep: mockLogStep,
  logError: mockLogError,
  logInfo: mockLogInfo,
  spinnerStart: mockSpinnerStart,
  spinnerStop: mockSpinnerStop,
  spinnerMessage: mockSpinnerMessage,
} = mockClackPrompts({
  select: mockSelect,
});

const { cmdRun } = await import("../commands.js");

// ── Test helpers ─────────────────────────────────────────────────────────────

const VALID_SCRIPT = "#!/bin/bash\nset -eo pipefail\nexit 0";

function mockFetchOk(scriptContent = VALID_SCRIPT) {
  return mock(async (url: string | URL | Request) => {
    const urlStr = isString(url) ? url : url instanceof URL ? url.href : url instanceof Request ? url.url : String(url);
    if (urlStr.includes("manifest.json")) {
      return new Response(JSON.stringify(mockManifest));
    }
    return new Response(scriptContent, {
      status: 200,
    });
  });
}

/** Build a SpawnRecord that passes the getActiveServers() filter. */
function activeRecord(name: string, agent: string, cloud: string) {
  return {
    agent,
    cloud,
    name,
    timestamp: new Date().toISOString(),
    connection: {
      ip: "1.2.3.4",
      user: "root",
      server_id: "srv-123",
      server_name: name,
      cloud,
    },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("cmdRun --name duplicate detection", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let historyDir: string;
  let originalSpawnHome: string | undefined;
  let originalSpawnName: string | undefined;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogWarn.mockClear();
    mockLogStep.mockClear();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();
    mockSelect.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;
    originalSpawnHome = process.env.SPAWN_HOME;
    originalSpawnName = process.env.SPAWN_NAME;

    historyDir = join(homedir(), `spawn-dup-test-${Date.now()}-${Math.random()}`);
    mkdirSync(historyDir, {
      recursive: true,
    });
    process.env.SPAWN_HOME = historyDir;
    // Clean SPAWN_NAME before each test
    delete process.env.SPAWN_NAME;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);

    process.env.SPAWN_HOME = originalSpawnHome;
    if (originalSpawnName !== undefined) {
      process.env.SPAWN_NAME = originalSpawnName;
    } else {
      delete process.env.SPAWN_NAME;
    }

    if (historyDir) {
      rmSync(historyDir, {
        recursive: true,
        force: true,
      });
    }
  });

  it("shows warning and picker when --name matches an active instance", async () => {
    // Pre-populate history with an active server named "alexclaw-do"
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        activeRecord("alexclaw-do", "claude", "sprite"),
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    // Simulate `spawn claude sprite --name "alexclaw-do"`
    process.env.SPAWN_NAME = "alexclaw-do";
    await cmdRun("claude", "sprite");

    // Warning should have been shown
    const warnCalls = mockLogWarn.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(warnCalls.some((msg) => msg.includes("already exists"))).toBe(true);
    expect(warnCalls.some((msg) => msg.includes("alexclaw-do"))).toBe(true);
  });

  it("presents the action picker when a duplicate is found", async () => {
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        activeRecord("mydev", "claude", "sprite"),
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    process.env.SPAWN_NAME = "mydev";
    await cmdRun("claude", "sprite");

    // p.select should have been called to present the action picker
    expect(mockSelect.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("proceeds to normal provisioning when no active instance matches the name", async () => {
    // History contains a different name
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        activeRecord("other-instance", "claude", "sprite"),
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    process.env.SPAWN_NAME = "brand-new";
    await cmdRun("claude", "sprite");

    // No warning should be shown — it's a fresh instance
    const warnCalls = mockLogWarn.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(warnCalls.some((msg) => msg.includes("already exists"))).toBe(false);

    // Picker should not be invoked
    expect(mockSelect.mock.calls.length).toBe(0);
  });

  it("proceeds normally when no name is set and history has an active instance", async () => {
    // No SPAWN_NAME — promptSpawnName returns undefined from text prompt
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        activeRecord("existing", "claude", "sprite"),
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    // No SPAWN_NAME set — text mock returns undefined
    await cmdRun("claude", "sprite");

    // No warning, no picker — name is undefined so duplicate check is skipped
    const warnCalls = mockLogWarn.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(warnCalls.some((msg) => msg.includes("already exists"))).toBe(false);
    expect(mockSelect.mock.calls.length).toBe(0);
  });

  it("does not match when agent differs", async () => {
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        activeRecord("mydev", "codex", "sprite"),
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    // Same name, same cloud, but DIFFERENT agent
    process.env.SPAWN_NAME = "mydev";
    await cmdRun("claude", "sprite");

    const warnCalls = mockLogWarn.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(warnCalls.some((msg) => msg.includes("already exists"))).toBe(false);
    expect(mockSelect.mock.calls.length).toBe(0);
  });

  it("does not match when cloud differs", async () => {
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        activeRecord("mydev", "claude", "hetzner"),
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    // Same name, same agent, but DIFFERENT cloud
    process.env.SPAWN_NAME = "mydev";
    await cmdRun("claude", "sprite");

    const warnCalls = mockLogWarn.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(warnCalls.some((msg) => msg.includes("already exists"))).toBe(false);
    expect(mockSelect.mock.calls.length).toBe(0);
  });

  it("does not detect deleted instances as duplicates", async () => {
    const deletedRecord = {
      ...activeRecord("mydev", "claude", "sprite"),
      connection: {
        ip: "1.2.3.4",
        user: "root",
        server_id: "srv-123",
        server_name: "mydev",
        cloud: "sprite",
        deleted: true,
        deleted_at: new Date().toISOString(),
      },
    };
    writeFileSync(
      join(historyDir, "history.json"),
      JSON.stringify([
        deletedRecord,
      ]),
    );

    global.fetch = mockFetchOk();
    await loadManifest(true);

    process.env.SPAWN_NAME = "mydev";
    await cmdRun("claude", "sprite");

    // Deleted instances should not trigger duplicate detection
    const warnCalls = mockLogWarn.mock.calls.map((c: unknown[]) => c.join(" "));
    expect(warnCalls.some((msg) => msg.includes("already exists"))).toBe(false);
    expect(mockSelect.mock.calls.length).toBe(0);
  });
});
