/**
 * sprite-keep-alive.test.ts — Tests for Sprite keep-alive integration.
 *
 * Verifies:
 * - installSpriteKeepAlive() downloads and installs the keep-alive script
 * - installSpriteKeepAlive() is gracefully non-fatal when download fails
 * - interactiveSession() wraps the cmd in a session script with keep-alive support
 *
 * Uses dependency injection (spawnFn param) for interactiveSession instead of
 * mock.module to avoid process-global mock pollution.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// ── Import module under test directly (no mock.module needed) ────────────────

import { installSpriteKeepAlive, interactiveSession } from "../sprite/sprite";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Bun.SubprocessResult for spawnSync. */
function makeSyncResult(exitCode: number, stdout = ""): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    success: exitCode === 0,
    signalCode: null,
    resourceUsage: undefined,
    exited: exitCode,
    pid: 1234,
  };
}

/** Build a minimal mock subprocess for Bun.spawn. */
function makeSpawnResult(exitCode: number): {
  exited: Promise<number>;
  stderr: ReadableStream;
} {
  return {
    exited: Promise.resolve(exitCode),
    stderr: new ReadableStream(),
  };
}

// ── Tests: installSpriteKeepAlive ─────────────────────────────────────────────

describe("installSpriteKeepAlive", () => {
  let spawnSyncSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    // Make getSpriteCmd() find "sprite" via `which sprite`
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "which" && args[1] === "sprite") {
        return makeSyncResult(0, "sprite");
      }
      // sprite version call
      return makeSyncResult(0, "sprite v1.0.0");
    });

    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => makeSpawnResult(0));
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("downloads and installs the keep-alive script to ~/.local/bin", async () => {
    const capturedCmds: string[] = [];
    spawnSpy.mockImplementation((args: string[]) => {
      const bashIdx = args.indexOf("bash");
      if (bashIdx !== -1 && args[bashIdx + 1] === "-c") {
        capturedCmds.push(args[bashIdx + 2]);
      }
      return makeSpawnResult(0);
    });

    await installSpriteKeepAlive();

    expect(capturedCmds.some((cmd) => cmd.includes("kurt-claw-f.sprites.app/sprite-keep-running.sh"))).toBe(true);
    expect(capturedCmds.some((cmd) => cmd.includes("sprite-keep-running"))).toBe(true);
    expect(capturedCmds.some((cmd) => cmd.includes(".local/bin/sprite-keep-running"))).toBe(true);
    expect(capturedCmds.some((cmd) => cmd.includes("chmod +x"))).toBe(true);
  });

  it("does not throw when script download fails", async () => {
    // Simulate runSprite throwing (process exits with code 1)
    spawnSpy.mockImplementation(() => makeSpawnResult(1));

    // Should resolve without throwing
    await expect(installSpriteKeepAlive()).resolves.toBeUndefined();
  });
});

// ── Tests: interactiveSession ─────────────────────────────────────────────────

describe("interactiveSession (keep-alive wrapper)", () => {
  let spawnSyncSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  const mockSpawnInteractive = mock((_args: string[]) => 0);

  beforeEach(() => {
    mockSpawnInteractive.mockClear();
    mockSpawnInteractive.mockImplementation(() => 0);
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    // Make getSpriteCmd() find "sprite"
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation((args: string[]) => {
      if (Array.isArray(args) && args[0] === "which" && args[1] === "sprite") {
        return makeSyncResult(0, "sprite");
      }
      return makeSyncResult(0, "sprite v1.0.0");
    });
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
    stderrSpy.mockRestore();
    delete process.env.SPAWN_PROMPT;
  });

  it("session script contains all expected structural elements", async () => {
    const testCmd = "openclaw tui";
    const expectedB64 = Buffer.from(testCmd).toString("base64");

    let capturedSessionScript = "";
    mockSpawnInteractive.mockImplementation((args: string[]) => {
      const bashIdx = args.indexOf("bash");
      if (bashIdx !== -1 && args[bashIdx + 1] === "-c") {
        capturedSessionScript = args[bashIdx + 2];
      }
      return 0;
    });

    await interactiveSession(testCmd, mockSpawnInteractive);

    // base64-encoded command is embedded
    expect(capturedSessionScript).toContain(expectedB64);
    // keep-alive check is present
    expect(capturedSessionScript).toContain("sprite-keep-running");
    expect(capturedSessionScript).toContain("command -v sprite-keep-running");
    // temp file management
    expect(capturedSessionScript).toContain("mktemp");
    expect(capturedSessionScript).toContain("base64 -d");
    expect(capturedSessionScript).toContain("trap");
    // fallback to plain bash
    expect(capturedSessionScript).toContain("else");
    expect(capturedSessionScript).toMatch(/else[\s\S]*bash/);
  });

  it("handles multi-line restart loop commands (base64-encoded as single token)", async () => {
    const multilineCmd = [
      "_spawn_restarts=0",
      "while [ $_spawn_restarts -lt 10 ]; do",
      "  openclaw tui",
      "  _spawn_exit=$?",
      "  _spawn_restarts=$((_spawn_restarts + 1))",
      "done",
    ].join("\n");

    const expectedB64 = Buffer.from(multilineCmd).toString("base64");
    let capturedSessionScript = "";
    mockSpawnInteractive.mockImplementation((args: string[]) => {
      const bashIdx = args.indexOf("bash");
      if (bashIdx !== -1 && args[bashIdx + 1] === "-c") {
        capturedSessionScript = args[bashIdx + 2];
      }
      return 0;
    });

    await interactiveSession(multilineCmd, mockSpawnInteractive);

    expect(capturedSessionScript).toContain(expectedB64);
  });

  it("uses -tty flag for interactive mode (SPAWN_PROMPT not set)", async () => {
    delete process.env.SPAWN_PROMPT;

    let capturedArgs: string[] = [];
    mockSpawnInteractive.mockImplementation((args: string[]) => {
      capturedArgs = args;
      return 0;
    });

    await interactiveSession("agent-cmd", mockSpawnInteractive);

    expect(capturedArgs).toContain("-tty");
  });

  it("omits -tty flag when SPAWN_PROMPT is set", async () => {
    process.env.SPAWN_PROMPT = "non-interactive";

    let capturedArgs: string[] = [];
    mockSpawnInteractive.mockImplementation((args: string[]) => {
      capturedArgs = args;
      return 0;
    });

    await interactiveSession("agent-cmd", mockSpawnInteractive);

    expect(capturedArgs).not.toContain("-tty");
  });

  it("returns the exit code from spawnInteractive", async () => {
    mockSpawnInteractive.mockImplementation(() => 42);

    const exitCode = await interactiveSession("agent-cmd", mockSpawnInteractive);

    expect(exitCode).toBe(42);
  });
});
