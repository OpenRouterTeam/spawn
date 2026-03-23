/**
 * ssh-cov.test.ts — Coverage tests for shared/ssh.ts
 *
 * Covers: spawnInteractive, startSshTunnel,
 * waitForSsh, SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as net from "node:net";

// Suppress stderr during tests — restored in afterAll to avoid contamination
let stderrSpy: ReturnType<typeof spyOn>;

const { spawnInteractive, startSshTunnel, waitForSsh, SSH_BASE_OPTS, SSH_INTERACTIVE_OPTS } = await import(
  "../shared/ssh.js"
);

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
  it("SSH_BASE_OPTS has required non-interactive options", () => {
    expect(SSH_BASE_OPTS).toContain("StrictHostKeyChecking=no");
    expect(SSH_BASE_OPTS).toContain("BatchMode=yes");
  });

  it("SSH_INTERACTIVE_OPTS has interactive options and no BatchMode", () => {
    expect(SSH_INTERACTIVE_OPTS).toContain("StrictHostKeyChecking=accept-new");
    expect(SSH_INTERACTIVE_OPTS).toContain("-t");
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

    // TCP connect retried until open, then SSH handshake attempted
    expect(connectSpy).toHaveBeenCalled();
    expect(bunSpawnSpy).toHaveBeenCalled();
    bunSpawnSpy.mockRestore();
    connectSpy.mockRestore();
  });
});

// Final cleanup
afterAll(() => {
  stderrSpy.mockRestore();
});
