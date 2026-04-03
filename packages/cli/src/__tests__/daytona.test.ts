import type { VMConnection } from "../history.js";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts();

class MockDaytonaNotFoundError extends Error {}

interface MockCommandResult {
  exitCode: number;
  result: string;
}

class MockSandbox {
  id: string;
  name: string;
  user: string;
  state: string;
  homeDir = "/home/daytona";
  workDir = "/workspace";
  sshAccess = {
    token: "token-123",
    sshCommand: "ssh -p 2222 token-123@ssh.app.daytona.io",
  };
  previewBaseUrl = "https://preview.daytona.test/base";
  commandResponses: Array<MockCommandResult | Error> = [];
  processCalls: Array<{
    command: string;
    cwd: string | undefined;
    env: Record<string, string> | undefined;
    timeout: number | undefined;
  }> = [];
  uploadCalls: Array<{
    source: unknown;
    destination: string;
  }> = [];
  downloadCalls: Array<{
    source: string;
    destination: string;
  }> = [];
  previewCalls: Array<{
    port: number;
    expiresInSeconds: number | undefined;
  }> = [];
  startCalls = 0;

  fs = {
    uploadFile: async (source: unknown, destination: string) => {
      this.uploadCalls.push({
        source,
        destination,
      });
    },
    downloadFile: async (source: string, destination: string) => {
      this.downloadCalls.push({
        source,
        destination,
      });
    },
  };

  process = {
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<MockCommandResult> => {
      this.processCalls.push({
        command,
        cwd,
        env,
        timeout,
      });

      const next = this.commandResponses.shift() ?? {
        exitCode: 0,
        result: "",
      };
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };

  constructor(id: string, name: string, state = "started") {
    this.id = id;
    this.name = name;
    this.user = "daytona";
    this.state = state;
  }

  async getUserHomeDir(): Promise<string> {
    return this.homeDir;
  }

  async getWorkDir(): Promise<string> {
    return this.workDir;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.state = "started";
  }

  async createSshAccess(): Promise<{
    token: string;
    sshCommand: string;
  }> {
    return this.sshAccess;
  }

  async getSignedPreviewUrl(
    port: number,
    expiresInSeconds?: number,
  ): Promise<{
    url: string;
  }> {
    this.previewCalls.push({
      port,
      expiresInSeconds,
    });
    return {
      url: `${this.previewBaseUrl}/${port}`,
    };
  }
}

const mockState: {
  clientConfigs: Array<Record<string, string | undefined>>;
  createArgs: Array<Record<string, unknown>>;
  deleteIds: string[];
  listCalls: Array<{
    page: number;
    limit: number;
  }>;
  sandboxes: Map<string, MockSandbox>;
} = {
  clientConfigs: [],
  createArgs: [],
  deleteIds: [],
  listCalls: [],
  sandboxes: new Map<string, MockSandbox>(),
};

function resetMockState(): void {
  mockState.clientConfigs.length = 0;
  mockState.createArgs.length = 0;
  mockState.deleteIds.length = 0;
  mockState.listCalls.length = 0;
  mockState.sandboxes.clear();
}

class MockDaytona {
  constructor(config: Record<string, string | undefined>) {
    mockState.clientConfigs.push(config);
  }

  async list(
    _target?: string,
    page = 1,
    limit = 100,
  ): Promise<{
    items: MockSandbox[];
  }> {
    mockState.listCalls.push({
      page,
      limit,
    });
    return {
      items: Array.from(mockState.sandboxes.values()),
    };
  }

  async create(params: Record<string, unknown>): Promise<MockSandbox> {
    mockState.createArgs.push(params);
    const sandbox = new MockSandbox(`sb-${mockState.createArgs.length}`, String(params.name));
    mockState.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async get(id: string): Promise<MockSandbox> {
    const sandbox = mockState.sandboxes.get(id);
    if (!sandbox) {
      throw new MockDaytonaNotFoundError(`Sandbox not found: ${id}`);
    }
    return sandbox;
  }

  async delete(sandbox: MockSandbox): Promise<void> {
    mockState.deleteIds.push(sandbox.id);
    mockState.sandboxes.delete(sandbox.id);
  }
}

mock.module("@daytonaio/sdk", () => ({
  Daytona: MockDaytona,
  DaytonaNotFoundError: MockDaytonaNotFoundError,
}));

const daytona = await import("../daytona/daytona.js");

describe("daytona/daytona", () => {
  let savedHome: string | undefined;
  let savedDaytonaApiKey: string | undefined;
  let testHome: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedDaytonaApiKey = process.env.DAYTONA_API_KEY;
    testHome = join(tmpdir(), `spawn-daytona-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testHome, {
      recursive: true,
    });
    process.env.HOME = testHome;
    process.env.DAYTONA_API_KEY = "test-daytona-key";

    resetMockState();
    daytona.resetDaytonaState();
  });

  afterEach(() => {
    daytona.resetDaytonaState();
    resetMockState();

    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }

    if (savedDaytonaApiKey === undefined) {
      delete process.env.DAYTONA_API_KEY;
    } else {
      process.env.DAYTONA_API_KEY = savedDaytonaApiKey;
    }

    rmSync(testHome, {
      recursive: true,
      force: true,
    });
  });

  it("authenticates with the Daytona SDK using DAYTONA_API_KEY", async () => {
    const client = await daytona.getDaytonaClient(false);

    expect(client).not.toBeNull();
    expect(mockState.clientConfigs[0]).toMatchObject({
      apiKey: "test-daytona-key",
    });
    expect(mockState.listCalls.length).toBeGreaterThan(0);
  });

  it("creates sandboxes with Spawn labels and disabled cleanup timers", async () => {
    const connection = await daytona.createServer("spawn-daytona");

    expect(connection).toMatchObject({
      ip: "ssh.app.daytona.io",
      user: "daytona",
      server_id: "sb-1",
      server_name: "spawn-daytona",
      cloud: "daytona",
    });
    expect(mockState.createArgs[0]).toMatchObject({
      name: "spawn-daytona",
      autoStopInterval: 0,
      autoArchiveInterval: 0,
      autoDeleteInterval: -1,
      labels: {
        "managed-by": "spawn",
        cloud: "daytona",
      },
    });
  });

  it("maps Daytona sandbox states and not-found errors", async () => {
    mockState.sandboxes.set("sb-running", new MockSandbox("sb-running", "running", "starting"));
    mockState.sandboxes.set("sb-stopped", new MockSandbox("sb-stopped", "stopped", "archived"));

    expect(await daytona.getDaytonaLiveState("sb-running")).toBe("running");
    expect(await daytona.getDaytonaLiveState("sb-stopped")).toBe("stopped");
    expect(await daytona.getDaytonaLiveState("sb-missing")).toBe("gone");
  });

  it("builds interactive SSH arguments from fresh SSH access", async () => {
    const sandbox = new MockSandbox("sb-ssh", "ssh-test");
    sandbox.sshAccess = {
      token: "token-abc",
      sshCommand: "ssh -p 2200 token-abc@ssh.daytona.test",
    };
    mockState.sandboxes.set(sandbox.id, sandbox);

    const args = await daytona.buildInteractiveSshArgs("sb-ssh", "claude");

    expect(args).toContain("PubkeyAuthentication=no");
    expect(args).toContain("Port=2200");
    expect(args).toContain("token-abc@ssh.daytona.test");
    expect(args.at(-1)).toContain("bash -lc");
  });

  it("builds signed preview URLs with validated suffixes", async () => {
    const sandbox = new MockSandbox("sb-preview", "preview-test");
    sandbox.previewBaseUrl = "https://preview.daytona.test/base";
    mockState.sandboxes.set(sandbox.id, sandbox);

    const url = await daytona.getSignedPreviewBrowserUrl("sb-preview", 3000, "/ui", 1200);

    expect(url).toBe("https://preview.daytona.test/base/3000/ui");
    expect(sandbox.previewCalls[0]).toEqual({
      port: 3000,
      expiresInSeconds: 1200,
    });
  });

  it("forwards process timeouts and rejects non-zero command exits", async () => {
    const sandbox = new MockSandbox("sb-command", "command-test");
    sandbox.commandResponses.push({
      exitCode: 0,
      result: "ok",
    });
    mockState.sandboxes.set(sandbox.id, sandbox);

    const result = await daytona.runDaytonaCommand("sb-command", "echo ok", 42);
    expect(result).toEqual({
      exitCode: 0,
      output: "ok",
    });
    expect(sandbox.processCalls[0].timeout).toBe(42);

    const connection = await daytona.createServer("runserver-test");
    const activeSandbox = mockState.sandboxes.get(connection.server_id!);
    activeSandbox!.commandResponses.push({
      exitCode: 1,
      result: "bad exit",
    });

    await expect(daytona.runServer("echo nope", 7)).rejects.toThrow(/runServer failed/);
    expect(activeSandbox!.processCalls[0].timeout).toBe(7);
  });

  it("normalizes remote upload and download paths through Daytona filesystem APIs", async () => {
    const connection = await daytona.createServer("path-test");
    const sandbox = mockState.sandboxes.get(connection.server_id!);
    sandbox!.homeDir = "/home/daytona";
    sandbox!.workDir = "/workspace/project";

    await daytona.uploadFile("/tmp/local.txt", "$HOME/.config/spawn/daytona.json");
    await daytona.downloadFile("logs/output.log", "/tmp/output.log");

    expect(sandbox!.uploadCalls[0]).toEqual({
      source: "/tmp/local.txt",
      destination: "/home/daytona/.config/spawn/daytona.json",
    });
    expect(sandbox!.downloadCalls[0]).toEqual({
      source: "/workspace/project/logs/output.log",
      destination: "/tmp/output.log",
    });
  });

  it("probes agent binaries through the process API", async () => {
    const sandbox = new MockSandbox("sb-probe", "probe-test");
    sandbox.commandResponses.push({
      exitCode: 0,
      result: "claude 1.0.0",
    });
    mockState.sandboxes.set(sandbox.id, sandbox);

    const ok = await daytona.probeDaytonaAgentBinary("sb-probe", "claude");

    expect(ok).toBe(true);
    expect(sandbox.processCalls[0].command).toContain("claude --version");
  });

  it("validates strict Daytona record shapes and rejects persisted secrets", () => {
    const currentShape: VMConnection = {
      ip: "ssh.app.daytona.io",
      user: "daytona",
      server_id: "sb-123",
      server_name: "daytona-sb",
      cloud: "daytona",
      metadata: {
        tunnel_remote_port: "3000",
        tunnel_browser_url_template: "http://localhost:__PORT__/ui",
      },
    };

    expect(() => daytona.validateDaytonaConnection(currentShape)).not.toThrow();
    expect(() =>
      daytona.validateDaytonaConnection({
        ...currentShape,
        ip: "token-auth",
      }),
    ).toThrow(/Invalid Daytona connection shape/);
    expect(() =>
      daytona.validateDaytonaConnection({
        ...currentShape,
        metadata: {
          ssh_token: "secret",
        },
      }),
    ).toThrow(/Invalid Daytona metadata key/);
    expect(() =>
      daytona.validateDaytonaConnection({
        ...currentShape,
        metadata: {
          signed_preview_url: "https://preview.daytona.test/private",
        },
      }),
    ).toThrow(/Invalid Daytona metadata key/);
  });
});
