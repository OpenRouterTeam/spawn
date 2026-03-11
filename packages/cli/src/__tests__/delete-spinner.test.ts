/**
 * delete-spinner.test.ts — Tests that confirmAndDelete feeds cloud destroy
 * stderr output into the spinner message, then clears the spinner and shows
 * the final result via p.log.success/error with the last stderr message.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mockClackPrompts } from "./test-helpers.js";

// ── Mock @clack/prompts (must be before importing the module under test) ──
const clack = mockClackPrompts({
  confirm: mock(async () => true),
});

// ── Mock cloud modules so execDeleteServer doesn't make real API calls ──
const mockHetznerDestroy = mock(() => Promise.resolve());
mock.module("../hetzner/hetzner.js", () => ({
  ensureHcloudToken: mock(() => Promise.resolve()),
  destroyServer: mockHetznerDestroy,
}));

// Stub other clouds to avoid import errors
mock.module("../aws/aws.js", () => ({
  ensureAwsCli: mock(() => Promise.resolve()),
  authenticate: mock(() => Promise.resolve()),
  destroyServer: mock(() => Promise.resolve()),
}));
mock.module("../digitalocean/digitalocean.js", () => ({
  ensureDoToken: mock(() => Promise.resolve()),
  destroyServer: mock(() => Promise.resolve()),
}));
mock.module("../gcp/gcp.js", () => ({
  ensureGcloudCli: mock(() => Promise.resolve()),
  authenticate: mock(() => Promise.resolve()),
  resolveProject: mock(() => Promise.resolve()),
  destroyInstance: mock(() => Promise.resolve()),
}));
mock.module("../sprite/sprite.js", () => ({
  ensureSpriteCli: mock(() => Promise.resolve()),
  ensureSpriteAuthenticated: mock(() => Promise.resolve()),
  destroyServer: mock(() => Promise.resolve()),
}));

// History uses real module — SPAWN_HOME is pointed at a temp dir in beforeEach

// ── Import the module under test ──────────────────────────────────────────
const { confirmAndDelete } = await import("../commands/delete.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRecord(cloud: string, serverName: string) {
  return {
    id: "test-id",
    agent: "claude",
    cloud,
    timestamp: new Date().toISOString(),
    connection: {
      ip: "10.0.0.1",
      user: "root",
      server_name: serverName,
      cloud,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("confirmAndDelete spinner behavior", () => {
  let testDir: string;
  let savedSpawnHome: string | undefined;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `.spawn-test-delete-${Date.now()}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;

    clack.confirm.mockImplementation(async () => true);
    clack.spinnerStart.mockClear();
    clack.spinnerStop.mockClear();
    clack.spinnerMessage.mockClear();
    clack.spinnerClear.mockClear();
    clack.logSuccess.mockClear();
    clack.logError.mockClear();
    mockHetznerDestroy.mockClear();
  });

  afterEach(() => {
    if (savedSpawnHome !== undefined) {
      process.env.SPAWN_HOME = savedSpawnHome;
    } else {
      delete process.env.SPAWN_HOME;
    }
    rmSync(testDir, {
      recursive: true,
      force: true,
    });
  });

  it("feeds stderr output from destroy into spinner.message()", async () => {
    // Simulate a cloud destroy function that writes progress to stderr
    mockHetznerDestroy.mockImplementation(async () => {
      process.stderr.write("\x1b[36mDestroying Hetzner server srv-123...\x1b[0m\n");
      process.stderr.write("\x1b[32mServer srv-123 destroyed\x1b[0m\n");
    });

    const record = makeRecord("hetzner", "srv-123");
    const result = await confirmAndDelete(record, null);

    expect(result).toBe(true);

    // Spinner should have received stripped (no ANSI) messages
    const messageCalls = clack.spinnerMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(messageCalls).toContain("Destroying Hetzner server srv-123...");
    expect(messageCalls).toContain("Server srv-123 destroyed");
  });

  it("calls spinner.clear() instead of spinner.stop()", async () => {
    mockHetznerDestroy.mockImplementation(async () => {
      process.stderr.write("Server srv-123 destroyed\n");
    });

    const record = makeRecord("hetzner", "srv-123");
    await confirmAndDelete(record, null);

    expect(clack.spinnerClear).toHaveBeenCalledTimes(1);
    expect(clack.spinnerStop).not.toHaveBeenCalled();
  });

  it("shows success with last stderr message as detail", async () => {
    mockHetznerDestroy.mockImplementation(async () => {
      process.stderr.write("Destroying Hetzner server srv-123...\n");
      process.stderr.write("Server srv-123 destroyed\n");
    });

    const record = makeRecord("hetzner", "srv-123");
    await confirmAndDelete(record, null);

    expect(clack.logSuccess).toHaveBeenCalledTimes(1);
    const msg = clack.logSuccess.mock.calls[0][0];
    expect(msg).toContain('Server "srv-123" deleted');
    expect(msg).toContain("Server srv-123 destroyed");
  });

  it("shows error with detail on delete failure", async () => {
    mockHetznerDestroy.mockImplementation(async () => {
      process.stderr.write("Connection refused\n");
      throw new Error("API timeout");
    });

    const record = makeRecord("hetzner", "srv-123");
    const result = await confirmAndDelete(record, null);

    expect(result).toBe(false);
    expect(clack.spinnerClear).toHaveBeenCalledTimes(1);
    expect(clack.logError).toHaveBeenCalled();
  });

  it("restores process.stderr.write after delete", async () => {
    const origWrite = process.stderr.write;

    mockHetznerDestroy.mockImplementation(async () => {
      process.stderr.write("done\n");
    });

    const record = makeRecord("hetzner", "srv-123");
    await confirmAndDelete(record, null);

    expect(process.stderr.write).toBe(origWrite);
  });

  it("restores process.stderr.write even on error", async () => {
    const origWrite = process.stderr.write;

    mockHetznerDestroy.mockImplementation(async () => {
      process.stderr.write("boom\n");
      throw new Error("kaboom");
    });

    const record = makeRecord("hetzner", "srv-123");
    await confirmAndDelete(record, null);

    expect(process.stderr.write).toBe(origWrite);
  });

  it("works with no stderr output from destroy", async () => {
    // Destroy succeeds silently
    mockHetznerDestroy.mockImplementation(async () => {});

    const record = makeRecord("hetzner", "srv-123");
    const result = await confirmAndDelete(record, null);

    expect(result).toBe(true);
    expect(clack.spinnerClear).toHaveBeenCalledTimes(1);
    expect(clack.logSuccess).toHaveBeenCalledTimes(1);
    // No detail suffix when no stderr output
    const msg = clack.logSuccess.mock.calls[0][0];
    expect(msg).toBe('Server "srv-123" deleted');
  });
});
