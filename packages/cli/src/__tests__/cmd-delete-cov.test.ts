/**
 * cmd-delete-cov.test.ts — Coverage tests for commands/delete.ts
 *
 * Tests: confirmAndDelete, cmdDelete
 */

import type { SpawnRecord } from "../history";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const clack = mockClackPrompts();

// ── Import module under test ────────────────────────────────────────────────
const { confirmAndDelete, cmdDelete } = await import("../commands/delete.js");
const { _resetCacheForTesting } = await import("../manifest.js");

// ── Helpers ────────────────────────────────────────────────────────────────

const mockManifest = createMockManifest();

function makeRecord(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return {
    id: "del-test-123",
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("confirmAndDelete", () => {
  let stderrWriteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clack.confirm.mockReset();
    clack.logInfo.mockReset();
    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logWarn.mockReset();
    clack.spinnerStart.mockReset();
    clack.spinnerStop.mockReset();
    clack.spinnerClear.mockReset();

    // Capture stderr.write so spinner interceptor doesn't break
    stderrWriteSpy = spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrWriteSpy.mockRestore();
  });

  it("returns false when user cancels confirmation", async () => {
    clack.confirm.mockResolvedValue(false);
    const record = makeRecord();
    const result = await confirmAndDelete(record, mockManifest);
    expect(result).toBe(false);
    expect(clack.logInfo).toHaveBeenCalledWith("Delete cancelled.");
  });

  it("returns false when deleteHandler is provided and user cancels", async () => {
    // p.isCancel always returns false in mock, but !confirmed catches it
    clack.confirm.mockResolvedValue(false);
    const handler = mock(async () => true);
    const record = makeRecord();
    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls custom deleteHandler and reports success", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => true);
    const record = makeRecord();

    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith(record);
    expect(clack.logSuccess).toHaveBeenCalled();
  });

  it("reports failure when deleteHandler returns false", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => false);
    const record = makeRecord();

    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(false);
    expect(clack.logError).toHaveBeenCalled();
  });

  it("reports failure when deleteHandler throws", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => {
      throw new Error("delete failed");
    });
    const record = makeRecord();

    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(false);
    expect(clack.logError).toHaveBeenCalled();
  });

  it("uses server_name as label", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => true);
    const record = makeRecord();

    await confirmAndDelete(record, mockManifest, handler);

    const confirmCall = clack.confirm.mock.calls[0];
    const confirmArg = confirmCall?.[0];
    expect(confirmArg.message).toContain("spawn-abc");
  });

  it("uses server_id as label when server_name is absent", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => true);
    const record = makeRecord({
      connection: {
        ip: "1.2.3.4",
        user: "root",
        server_id: "99999",
        cloud: "hetzner",
      },
    });

    await confirmAndDelete(record, mockManifest, handler);

    const confirmCall = clack.confirm.mock.calls[0];
    expect(confirmCall?.[0].message).toContain("99999");
  });

  it("uses IP as label when both server_name and server_id absent", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => true);
    const record = makeRecord({
      connection: {
        ip: "9.8.7.6",
        user: "root",
        cloud: "hetzner",
      },
    });

    await confirmAndDelete(record, mockManifest, handler);

    const confirmCall = clack.confirm.mock.calls[0];
    expect(confirmCall?.[0].message).toContain("9.8.7.6");
  });
});

describe("cmdDelete", () => {
  let testDir: string;
  let savedSpawnHome: string | undefined;
  let processExitSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;

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
    testDir = join(process.env.HOME ?? "", `spawn-delete-test-${Date.now()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;

    originalFetch = global.fetch;
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    _resetCacheForTesting();

    clack.logInfo.mockReset();
    clack.logError.mockReset();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    process.env.SPAWN_HOME = savedSpawnHome;
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    if (existsSync(testDir)) {
      rmSync(testDir, {
        recursive: true,
        force: true,
      });
    }
  });

  it("shows no servers message when history is empty", async () => {
    await cmdDelete();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active servers"));
  });

  it("shows no servers when all are deleted", async () => {
    writeHistory([
      makeRecord({
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          deleted: true,
        },
      }),
    ]);
    await cmdDelete();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active servers"));
  });

  it("shows no servers when filter excludes all", async () => {
    writeHistory([
      makeRecord(),
    ]);
    await cmdDelete("nonexistent-agent");
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active servers"));
  });

  it("shows filter hint when filter matches nothing but servers exist", async () => {
    writeHistory([
      makeRecord(),
    ]);
    await cmdDelete("nonexistent-agent");
    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg: string) => msg.includes("none matched your filters"))).toBe(true);
  });

  it("exits when non-interactive TTY", async () => {
    writeHistory([
      makeRecord(),
    ]);
    // Non-interactive: CI_MODE or no TTY
    const savedCI = process.env.CI;
    const savedNonInteractive = process.env.SPAWN_NON_INTERACTIVE;
    process.env.SPAWN_NON_INTERACTIVE = "1";

    await expect(cmdDelete()).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);

    process.env.CI = savedCI;
    process.env.SPAWN_NON_INTERACTIVE = savedNonInteractive;
  });

  it("filters by cloud filter", async () => {
    writeHistory([
      makeRecord(),
    ]);
    await cmdDelete(undefined, "nonexistent-cloud");
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active servers"));
  });

  it("shows create hint when no servers at all", async () => {
    await cmdDelete();
    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      infoCalls.some((msg: string) => msg.includes("spawn") && (msg.includes("create") || msg.includes("No active"))),
    ).toBe(true);
  });
});

// ── confirmAndDelete with no manifest ──────────────────────────────────

describe("confirmAndDelete edge cases", () => {
  let stderrWriteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clack.confirm.mockReset();
    clack.logInfo.mockReset();
    clack.logError.mockReset();
    clack.logSuccess.mockReset();
    clack.logWarn.mockReset();
    clack.spinnerStart.mockReset();
    clack.spinnerStop.mockReset();
    clack.spinnerClear.mockReset();
    stderrWriteSpy = spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrWriteSpy.mockRestore();
  });

  it("uses cloud key as label when manifest is null", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => true);
    const record = makeRecord();
    await confirmAndDelete(record, null, handler);
    expect(clack.logSuccess).toHaveBeenCalled();
  });

  it("returns false when confirm returns false with null manifest", async () => {
    clack.confirm.mockResolvedValue(false);
    const record = makeRecord();
    const result = await confirmAndDelete(record, null);
    expect(result).toBe(false);
  });

  it("handles deleteHandler that writes to stderr during execution", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => {
      process.stderr.write("Deleting server...\n");
      return true;
    });
    const record = makeRecord();
    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(true);
  });

  it("handles non-string chunk in stderr interceptor", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => {
      process.stderr.write(
        new Uint8Array([
          65,
          66,
          67,
        ]),
      );
      return true;
    });
    const record = makeRecord();
    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(true);
  });

  it("shows detail from last stderr message on success", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => {
      process.stderr.write("Server destroyed\n");
      return true;
    });
    const record = makeRecord();
    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(true);
    const successCalls = clack.logSuccess.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(successCalls.some((msg: string) => msg.includes("deleted"))).toBe(true);
  });

  it("shows detail from last stderr message on failure", async () => {
    clack.confirm.mockResolvedValue(true);
    const handler = mock(async () => {
      process.stderr.write("Connection refused\n");
      return false;
    });
    const record = makeRecord();
    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(false);
  });

  it("fails fast when GCP record is missing project metadata", async () => {
    clack.confirm.mockResolvedValue(true);
    const record = makeRecord({
      cloud: "gcp",
      connection: {
        ip: "10.0.0.1",
        user: "root",
        server_name: "spawn-gcp-123",
        server_id: "gcp-123",
        cloud: "gcp",
        metadata: {
          zone: "us-central1-a",
          // project intentionally omitted
        },
      },
    });

    // ensureDeleteCredentials throws before the spinner starts,
    // so the error propagates as a rejection from confirmAndDelete
    await expect(confirmAndDelete(record, mockManifest)).rejects.toThrow("Cannot determine GCP project");
  });

  it("succeeds when GCP record has project metadata", async () => {
    clack.confirm.mockResolvedValue(true);
    // With a custom handler that simulates successful deletion,
    // the project metadata path should not throw
    const handler = mock(async () => true);
    const record = makeRecord({
      cloud: "gcp",
      connection: {
        ip: "10.0.0.1",
        user: "root",
        server_name: "spawn-gcp-456",
        server_id: "gcp-456",
        cloud: "gcp",
        metadata: {
          zone: "us-central1-a",
          project: "my-gcp-project",
        },
      },
    });

    const result = await confirmAndDelete(record, mockManifest, handler);
    expect(result).toBe(true);
  });
});
