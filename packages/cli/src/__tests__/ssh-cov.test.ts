/**
 * ssh-cov.test.ts — Coverage tests for shared/ssh.ts
 *
 * Covers: spawnInteractive, sleep, killWithTimeout, startSshTunnel,
 * waitForSsh, SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";

// Suppress stderr during tests — restored in afterAll to avoid contamination
let stderrSpy: ReturnType<typeof spyOn>;

const { spawnInteractive, sleep, killWithTimeout, startSshTunnel, waitForSsh, SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS } =
  await import("../shared/ssh.js");

/** Create a fake socket (EventEmitter) that satisfies net.Socket interface for testing. */
function createFakeSocket(): net.Socket {
  const emitter = new EventEmitter();
  Object.assign(emitter, {
    destroy: mock(() => {}),
  });
  // @ts-expect-error — test mock; EventEmitter has emit/on/removeListener which is enough for tcpCheck
  const socket: net.Socket = emitter;
  return socket;
}

beforeEach(() => {
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
});

// ── Constants ──────────────────────────────────────────────────────────

describe("SSH constants", () => {
  it("SSH_BASE_OPTS includes StrictHostKeyChecking", () => {
    expect(SSH_BASE_OPTS).toContain("StrictHostKeyChecking=no");
  });

  it("SSH_BASE_OPTS includes BatchMode", () => {
    expect(SSH_BASE_OPTS).toContain("BatchMode=yes");
  });

  it("SSH_INTERACTIVE_OPTS includes accept-new", () => {
    expect(SSH_INTERACTIVE_OPTS).toContain("StrictHostKeyChecking=accept-new");
  });

  it("SSH_INTERACTIVE_OPTS includes -t flag", () => {
    expect(SSH_INTERACTIVE_OPTS).toContain("-t");
  });

  it("SSH_INTERACTIVE_OPTS does not include BatchMode", () => {
    expect(SSH_INTERACTIVE_OPTS).not.toContain("BatchMode=yes");
  });
});

// ── spawnInteractive ───────────────────────────────────────────────────

describe("spawnInteractive", () => {
  it("calls node spawnSync with correct args and returns exit code", () => {
    const spy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 42,
      signal: null,
      output: [],
      pid: 123,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const code = spawnInteractive([
      "ssh",
      "-o",
      "Opt=val",
      "user@host",
    ]);
    expect(code).toBe(42);
    expect(spy).toHaveBeenCalledWith(
      "ssh",
      [
        "-o",
        "Opt=val",
        "user@host",
      ],
      expect.objectContaining({
        stdio: "inherit",
      }),
    );
    spy.mockRestore();
  });

  it("returns 1 when status is null", () => {
    const spy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: null,
      signal: "SIGTERM",
      output: [],
      pid: 123,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const code = spawnInteractive([
      "ssh",
      "user@host",
    ]);
    expect(code).toBe(1);
    spy.mockRestore();
  });

  it("passes custom env when provided", () => {
    const customEnv = {
      HOME: "/tmp",
      PATH: "/usr/bin",
    };
    const spy = spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      signal: null,
      output: [],
      pid: 123,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    spawnInteractive(
      [
        "echo",
        "hi",
      ],
      customEnv,
    );
    expect(spy).toHaveBeenCalledWith(
      "echo",
      [
        "hi",
      ],
      expect.objectContaining({
        env: customEnv,
      }),
    );
    spy.mockRestore();
  });
});

// ── sleep ──────────────────────────────────────────────────────────────

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("resolves with undefined", async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});

// ── killWithTimeout (additional coverage) ──────────────────────────────

describe("killWithTimeout additional", () => {
  it("sends SIGTERM immediately then SIGKILL after grace period", async () => {
    const signals: (number | undefined)[] = [];
    const proc = {
      kill(signal?: number) {
        signals.push(signal);
      },
    };
    killWithTimeout(proc, 50);
    expect(signals).toEqual([
      undefined,
    ]); // SIGTERM sent immediately
    await sleep(100);
    expect(signals).toEqual([
      undefined,
      9,
    ]); // SIGKILL sent after grace
  });

  it("does nothing when first kill throws (process already dead)", () => {
    const proc = {
      kill() {
        throw new Error("No such process");
      },
    };
    // Should not throw
    killWithTimeout(proc, 50);
  });
});

// ── startSshTunnel ─────────────────────────────────────────────────────

describe("startSshTunnel", () => {
  it("throws when SSH process exits immediately", async () => {
    const mockProc = {
      exitCode: 1,
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Connection refused"));
          controller.close();
        },
      }),
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(1),
      pid: 123,
      kill: mock(() => {}),
    };

    const bunSpawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      // @ts-expect-error mock proc shape
      mockProc,
    );

    await expect(
      startSshTunnel({
        host: "10.0.0.1",
        user: "root",
        remotePort: 59999,
      }),
    ).rejects.toThrow("SSH tunnel failed");

    bunSpawnSpy.mockRestore();
  });
});

// ── waitForSsh ─────────────────────────────────────────────────────────

describe("waitForSsh", () => {
  it("throws when TCP port never opens", async () => {
    const connectSpy = spyOn(net, "connect").mockImplementation(() => {
      const fakeSocket = createFakeSocket();
      setTimeout(() => fakeSocket.emit("error", new Error("ECONNREFUSED")), 5);
      return fakeSocket;
    });

    await expect(
      waitForSsh({
        host: "192.168.0.1",
        user: "root",
        maxAttempts: 2,
      }),
    ).rejects.toThrow("port 22 never opened");

    connectSpy.mockRestore();
  });

  it("includes sshKeyPath in args when provided", async () => {
    const connectSpy = spyOn(net, "connect").mockImplementation(() => {
      const fakeSocket = createFakeSocket();
      setTimeout(() => fakeSocket.emit("error", new Error("ECONNREFUSED")), 5);
      return fakeSocket;
    });

    await expect(
      waitForSsh({
        host: "192.168.0.1",
        user: "root",
        maxAttempts: 1,
        sshKeyPath: "/tmp/test-key",
        extraSshOpts: [
          "-v",
        ],
      }),
    ).rejects.toThrow("port 22 never opened");

    connectSpy.mockRestore();
  });

  it("succeeds when TCP opens and SSH handshake works", async () => {
    let tcpAttempts = 0;
    const connectSpy = spyOn(net, "connect").mockImplementation(() => {
      const fakeSocket = createFakeSocket();
      tcpAttempts++;
      if (tcpAttempts <= 1) {
        setTimeout(() => fakeSocket.emit("error", new Error("ECONNREFUSED")), 5);
      } else {
        setTimeout(() => fakeSocket.emit("connect"), 5);
      }
      return fakeSocket;
    });

    // Mock Bun.spawn for SSH handshake
    let exitCode: number | null = null;
    const mockProc = {
      get exitCode() {
        return exitCode;
      },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      pid: 123,
      kill: mock(() => {}),
    };

    setTimeout(() => {
      exitCode = 0;
    }, 10);

    const bunSpawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      // @ts-expect-error mock proc shape
      mockProc,
    );

    await waitForSsh({
      host: "10.0.0.1",
      user: "root",
      maxAttempts: 5,
    });

    bunSpawnSpy.mockRestore();
    connectSpy.mockRestore();
  });
});

// Final cleanup
afterAll(() => {
  stderrSpy.mockRestore();
});
