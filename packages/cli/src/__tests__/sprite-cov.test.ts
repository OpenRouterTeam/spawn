import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import { getVmConnection } from "../sprite/sprite";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockSpawnSync(exitCode: number, stdout = "", stderr = "") {
  return spyOn(Bun, "spawnSync").mockReturnValue({
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
    success: exitCode === 0,
    signalCode: null,
    resourceUsage: undefined,
    pid: 1234,
  } satisfies ReturnType<typeof Bun.spawnSync>);
}

function mockBunSpawn(exitCode = 0, stdout = "", stderr = "") {
  const mockProc = {
    pid: 1234,
    exitCode: Promise.resolve(exitCode),
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(stderr));
        c.close();
      },
    }),
    kill: mock(() => {}),
    ref: () => {},
    unref: () => {},
    stdin: new WritableStream(),
    resourceUsage: () =>
      ({
        cpuTime: {
          system: 0,
          user: 0,
          total: 0,
        },
        maxRSS: 0,
        sharedMemorySize: 0,
        unsharedDataSize: 0,
        unsharedStackSize: 0,
        minorPageFaults: 0,
        majorPageFaults: 0,
        swapCount: 0,
        inBlock: 0,
        outBlock: 0,
        ipcMessagesSent: 0,
        ipcMessagesReceived: 0,
        signalsReceived: 0,
        voluntaryContextSwitches: 0,
        involuntaryContextSwitches: 0,
      }) satisfies ReturnType<ReturnType<typeof Bun.spawn>["resourceUsage"]>,
  };
  // biome-ignore lint: test mock
  return spyOn(Bun, "spawn").mockReturnValue(mockProc as ReturnType<typeof Bun.spawn>);
}

let origEnv: NodeJS.ProcessEnv;
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  origEnv = {
    ...process.env,
  };
  stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  process.env = origEnv;
  stderrSpy.mockRestore();
  mock.restore();
});

// ─── getVmConnection ─────────────────────────────────────────────────────────

describe("sprite/getVmConnection", () => {
  it("returns sprite-console as ip", () => {
    const conn = getVmConnection();
    expect(conn.ip).toBe("sprite-console");
    expect(conn.cloud).toBe("sprite");
  });
});

// ─── getServerName ───────────────────────────────────────────────────────────

describe("sprite/getServerName", () => {
  it("reads from SPRITE_NAME env", async () => {
    process.env.SPRITE_NAME = "test-sprite";
    const { getServerName } = await import("../sprite/sprite");
    const name = await getServerName();
    expect(name).toBe("test-sprite");
  });
});

// ─── ensureSpriteCli ─────────────────────────────────────────────────────────

describe("sprite/ensureSpriteCli", () => {
  it("reports version when sprite is available", async () => {
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("sprite v1.2.3"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { ensureSpriteCli } = await import("../sprite/sprite");
    await ensureSpriteCli();
    spy.mockRestore();
  });

  it("reports installed without version when version unavailable", async () => {
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("no version here"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { ensureSpriteCli } = await import("../sprite/sprite");
    await ensureSpriteCli();
    spy.mockRestore();
  });

  it("installs sprite CLI when not available", async () => {
    // which sprite fails first, then fails, then after install, which succeeds
    let spawnSyncCallCount = 0;
    const spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(() => {
      spawnSyncCallCount++;
      // After install, getSpriteCmd() is called again - make it succeed
      if (spawnSyncCallCount >= 2) {
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode("/usr/local/bin/sprite"),
          stderr: new TextEncoder().encode(""),
          success: true,
          signalCode: null,
          resourceUsage: undefined,
          pid: spawnSyncCallCount,
        } satisfies ReturnType<typeof Bun.spawnSync>;
      }
      return {
        exitCode: 1,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode(""),
        success: false,
        signalCode: null,
        resourceUsage: undefined,
        pid: spawnSyncCallCount,
      } satisfies ReturnType<typeof Bun.spawnSync>;
    });
    const spawnSpy = mockBunSpawn(0);

    const { ensureSpriteCli } = await import("../sprite/sprite");
    await ensureSpriteCli();
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it("throws when install fails", async () => {
    const spawnSyncSpy = mockSpawnSync(1);
    const spawnSpy = mockBunSpawn(1, "", "install error");

    const { ensureSpriteCli } = await import("../sprite/sprite");
    await expect(ensureSpriteCli()).rejects.toThrow("Sprite CLI install failed");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── ensureSpriteAuthenticated ───────────────────────────────────────────────

describe("sprite/ensureSpriteAuthenticated", () => {
  it("succeeds when already authenticated", async () => {
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("Currently selected org: myorg\nOrg list here"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { ensureSpriteAuthenticated } = await import("../sprite/sprite");
    await ensureSpriteAuthenticated();
    spy.mockRestore();
  });

  it("uses SPRITE_ORG from env", async () => {
    process.env.SPRITE_ORG = "env-org";
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("org list output"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { ensureSpriteAuthenticated } = await import("../sprite/sprite");
    await ensureSpriteAuthenticated();
    spy.mockRestore();
  });

  it("runs login when not authenticated and succeeds", async () => {
    // First: which sprite -> found
    // Second: org list -> fails (not authed)
    // Then: login (Bun.spawn) -> succeeds
    // Then: verify org list -> succeeds
    const spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 1,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode("not logged in"),
        success: false,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("Currently selected org: myorg"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 3,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const spawnSpy = mockBunSpawn(0);

    const { ensureSpriteAuthenticated } = await import("../sprite/sprite");
    await ensureSpriteAuthenticated();
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it("throws when login fails", async () => {
    const spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 1,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode("not logged in"),
        success: false,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const spawnSpy = mockBunSpawn(1);

    const { ensureSpriteAuthenticated } = await import("../sprite/sprite");
    await expect(ensureSpriteAuthenticated()).rejects.toThrow("Sprite login failed");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── createSprite ────────────────────────────────────────────────────────────

describe("sprite/createSprite", () => {
  it("reuses existing sprite if already exists", async () => {
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("my-sprite  running  2025-01-01\nother-sprite  running  2025-01-01"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { createSprite } = await import("../sprite/sprite");
    await createSprite("my-sprite");
    spy.mockRestore();
  });

  it("creates new sprite when not existing", async () => {
    // list returns empty, then create succeeds, then list again shows sprite
    const spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        // list -> no sprites
        exitCode: 0,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 3,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        // list after create shows sprite
        exitCode: 0,
        stdout: new TextEncoder().encode("new-sprite  running  2025-01-01"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 4,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    // Bun.spawn for `sprite create`
    const spawnSpy = mockBunSpawn(0);

    const { createSprite } = await import("../sprite/sprite");
    await createSprite("new-sprite");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── verifySpriteConnectivity ────────────────────────────────────────────────

describe("sprite/verifySpriteConnectivity", () => {
  it("succeeds on first attempt", async () => {
    // Set poll delay to 0 for tests
    process.env.SPRITE_CONNECTIVITY_POLL_DELAY = "0";
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/sprite"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("ok"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { verifySpriteConnectivity } = await import("../sprite/sprite");
    await verifySpriteConnectivity(1);
    spy.mockRestore();
  });
});

// ─── uploadFileSprite ────────────────────────────────────────────────────────

describe("sprite/uploadFileSprite", () => {
  it("rejects path traversal in remote path", async () => {
    const { uploadFileSprite } = await import("../sprite/sprite");
    await expect(uploadFileSprite("/local/file", "/root/bad;rm")).rejects.toThrow("Invalid remote path");
  });

  it("rejects argument injection", async () => {
    const { uploadFileSprite } = await import("../sprite/sprite");
    await expect(uploadFileSprite("/local/file", "/-evil")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(0);
    const { uploadFileSprite } = await import("../sprite/sprite");
    await uploadFileSprite("/tmp/local.txt", "/root/file.txt");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── downloadFileSprite ──────────────────────────────────────────────────────

describe("sprite/downloadFileSprite", () => {
  it("rejects path traversal", async () => {
    const { downloadFileSprite } = await import("../sprite/sprite");
    await expect(downloadFileSprite("/root/bad;rm", "/tmp/out")).rejects.toThrow("Invalid remote path");
  });

  it("handles $HOME prefix", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(0, "file contents");
    const { downloadFileSprite } = await import("../sprite/sprite");
    await downloadFileSprite("$HOME/file.txt", "/tmp/out.txt");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── destroyServer ───────────────────────────────────────────────────────────

describe("sprite/destroyServer", () => {
  it("succeeds when sprite destroy returns 0", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(0);
    const { destroyServer } = await import("../sprite/sprite");
    await destroyServer("test-sprite");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it("throws when sprite destroy fails", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(1, "", "destroy failed");
    const { destroyServer } = await import("../sprite/sprite");
    await expect(destroyServer("test-sprite")).rejects.toThrow("Sprite destruction failed");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── runSprite ───────────────────────────────────────────────────────────────

describe("sprite/runSprite", () => {
  it("executes command via sprite exec", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(0);
    const { runSprite } = await import("../sprite/sprite");
    await runSprite("echo hello");
    expect(spawnSpy).toHaveBeenCalled();
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(1);
    const { runSprite } = await import("../sprite/sprite");
    await expect(runSprite("failing-cmd")).rejects.toThrow("sprite exec failed");
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── setupShellEnvironment ───────────────────────────────────────────────────

describe("sprite/setupShellEnvironment", () => {
  it("sets up shell environment", async () => {
    const spawnSyncSpy = mockSpawnSync(0, "/usr/bin/sprite");
    const spawnSpy = mockBunSpawn(0);
    const { setupShellEnvironment } = await import("../sprite/sprite");
    await setupShellEnvironment();
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});
