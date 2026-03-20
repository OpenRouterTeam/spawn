import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mockClackPrompts } from "./test-helpers";

// Must mock clack before importing aws module
mockClackPrompts();

import {
  BUNDLES,
  DEFAULT_BUNDLE,
  getAwsConfigPath,
  getConnectionInfo,
  getState,
  loadCredsFromConfig,
  saveCredsToConfig,
} from "../aws/aws";

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

let origFetch: typeof global.fetch;
let origEnv: NodeJS.ProcessEnv;
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  origFetch = global.fetch;
  origEnv = {
    ...process.env,
  };
  stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  global.fetch = origFetch;
  process.env = origEnv;
  stderrSpy.mockRestore();
  mock.restore();
});

// ─── getState ────────────────────────────────────────────────────────────────

describe("aws/getState", () => {
  it("returns state object with expected shape", () => {
    const state = getState();
    // Region may be mutated by other tests sharing the module — just verify the shape
    expect(typeof state.awsRegion).toBe("string");
    expect(state.awsRegion.length).toBeGreaterThan(0);
    expect(typeof state.lightsailMode).toBe("string");
    expect(typeof state.instanceName).toBe("string");
    expect(typeof state.instanceIp).toBe("string");
    expect(typeof state.selectedBundle).toBe("string");
  });
});

// ─── getConnectionInfo ───────────────────────────────────────────────────────

describe("aws/getConnectionInfo", () => {
  it("returns host and user", () => {
    const info = getConnectionInfo();
    expect(info.user).toBe("ubuntu");
    expect(typeof info.host).toBe("string");
  });
});

// ─── BUNDLES ─────────────────────────────────────────────────────────────────

describe("aws/BUNDLES", () => {
  it("has at least 3 bundles", () => {
    expect(BUNDLES.length).toBeGreaterThanOrEqual(3);
  });

  it("each bundle has id and label", () => {
    for (const b of BUNDLES) {
      expect(b.id).toBeTruthy();
      expect(b.label).toBeTruthy();
    }
  });

  it("DEFAULT_BUNDLE is in BUNDLES list", () => {
    expect(BUNDLES).toContainEqual(DEFAULT_BUNDLE);
  });
});

// ─── Credential Persistence ──────────────────────────────────────────────────

describe("aws/credential-persistence", () => {
  let savedConfig: string | null = null;

  beforeEach(() => {
    const path = getAwsConfigPath();
    if (existsSync(path)) {
      savedConfig = readFileSync(path, "utf-8");
    } else {
      savedConfig = null;
    }
  });

  afterEach(() => {
    const path = getAwsConfigPath();
    if (savedConfig !== null) {
      writeFileSync(path, savedConfig);
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
  });

  it("saveCredsToConfig creates file and loadCredsFromConfig reads it", async () => {
    const testKey = "AKIAIOSFODNN7EXAMPLE";
    const testSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    await saveCredsToConfig(testKey, testSecret, "us-west-2");

    const loaded = loadCredsFromConfig();
    expect(loaded).not.toBeNull();
    expect(loaded?.accessKeyId).toBe(testKey);
    expect(loaded?.secretAccessKey).toBe(testSecret);
    expect(loaded?.region).toBe("us-west-2");
  });

  it("loadCredsFromConfig returns null for missing file", () => {
    const path = getAwsConfigPath();
    if (existsSync(path)) {
      unlinkSync(path);
    }
    expect(loadCredsFromConfig()).toBeNull();
  });

  it("loadCredsFromConfig returns null for bad JSON", () => {
    writeFileSync(getAwsConfigPath(), "NOT_JSON", {
      mode: 0o600,
    });
    expect(loadCredsFromConfig()).toBeNull();
  });

  it("loadCredsFromConfig returns null for invalid accessKeyId format", async () => {
    await saveCredsToConfig("bad!!!", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1");
    expect(loadCredsFromConfig()).toBeNull();
  });

  it("loadCredsFromConfig returns null for invalid secretAccessKey format", async () => {
    await saveCredsToConfig("AKIAIOSFODNN7EXAMPLE", "too-short", "us-east-1");
    expect(loadCredsFromConfig()).toBeNull();
  });

  it("loadCredsFromConfig defaults region to us-east-1 when not set", async () => {
    writeFileSync(
      getAwsConfigPath(),
      JSON.stringify({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      }),
      {
        mode: 0o600,
      },
    );
    const loaded = loadCredsFromConfig();
    expect(loaded?.region).toBe("us-east-1");
  });
});

// ─── ensureAwsCli ────────────────────────────────────────────────────────────

describe("aws/ensureAwsCli", () => {
  it("does nothing if aws CLI is already available", async () => {
    const spy = mockSpawnSync(0, "/usr/local/bin/aws");
    const { ensureAwsCli } = await import("../aws/aws");
    await ensureAwsCli();
    spy.mockRestore();
  });

  it("skips install in non-interactive mode", async () => {
    const spy = mockSpawnSync(1);
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { ensureAwsCli } = await import("../aws/aws");
    await ensureAwsCli();
    spy.mockRestore();
  });
});

// ─── authenticate ────────────────────────────────────────────────────────────

describe("aws/authenticate", () => {
  it("throws on invalid region", async () => {
    process.env.AWS_DEFAULT_REGION = "invalid region with spaces!!";
    const { authenticate } = await import("../aws/aws");
    await expect(authenticate()).rejects.toThrow("Invalid AWS region");
  });

  it("uses CLI mode when aws sts succeeds", async () => {
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.LIGHTSAIL_REGION;
    // First call: which aws -> success; Second call: sts get-caller-identity -> success
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/aws"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode('{"Account":"123"}'),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { authenticate, getState: getAwsState } = await import("../aws/aws");
    await authenticate();
    expect(getAwsState().lightsailMode).toBe("cli");
    spy.mockRestore();
  });

  it("uses REST mode from env vars when no CLI", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.LIGHTSAIL_REGION;
    // which aws -> fails
    const spy = mockSpawnSync(1);
    const { authenticate, getState: getAwsState } = await import("../aws/aws");
    await authenticate();
    expect(getAwsState().lightsailMode).toBe("rest");
    spy.mockRestore();
  });

  it("throws in non-interactive mode with no credentials", async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.LIGHTSAIL_REGION;
    process.env.SPAWN_NON_INTERACTIVE = "1";
    process.env.SPAWN_REAUTH = "1"; // skip cache

    const spy = mockSpawnSync(1); // no aws cli
    const { authenticate } = await import("../aws/aws");
    await expect(authenticate()).rejects.toThrow("No AWS credentials");
    spy.mockRestore();
  });
});

// ─── promptRegion ────────────────────────────────────────────────────────────

describe("aws/promptRegion", () => {
  it("uses AWS_DEFAULT_REGION from env", async () => {
    process.env.AWS_DEFAULT_REGION = "eu-west-1";
    const { promptRegion } = await import("../aws/aws");
    await promptRegion();
    // Should not throw
  });

  it("uses LIGHTSAIL_REGION from env", async () => {
    delete process.env.AWS_DEFAULT_REGION;
    process.env.LIGHTSAIL_REGION = "ap-northeast-1";
    const { promptRegion } = await import("../aws/aws");
    await promptRegion();
  });

  it("throws on invalid region in env", async () => {
    process.env.AWS_DEFAULT_REGION = "bad region!!";
    const { promptRegion } = await import("../aws/aws");
    await expect(promptRegion()).rejects.toThrow("Invalid AWS region");
  });

  it("returns early if SPAWN_CUSTOM is not set", async () => {
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.LIGHTSAIL_REGION;
    delete process.env.SPAWN_CUSTOM;
    const { promptRegion } = await import("../aws/aws");
    await promptRegion(); // no-op
  });
});

// ─── promptBundle ────────────────────────────────────────────────────────────

describe("aws/promptBundle", () => {
  it("uses LIGHTSAIL_BUNDLE from env", async () => {
    process.env.LIGHTSAIL_BUNDLE = "large_3_0";
    const { promptBundle, getState: gs } = await import("../aws/aws");
    await promptBundle();
    expect(gs().selectedBundle).toBe("large_3_0");
  });

  it("uses agent default for openclaw", async () => {
    delete process.env.LIGHTSAIL_BUNDLE;
    delete process.env.SPAWN_CUSTOM;
    const { promptBundle, getState: gs } = await import("../aws/aws");
    await promptBundle("openclaw");
    expect(gs().selectedBundle).toBe("medium_3_0");
  });

  it("uses DEFAULT_BUNDLE when no agent default", async () => {
    delete process.env.LIGHTSAIL_BUNDLE;
    delete process.env.SPAWN_CUSTOM;
    const { promptBundle, getState: gs } = await import("../aws/aws");
    await promptBundle("claude");
    expect(gs().selectedBundle).toBe(DEFAULT_BUNDLE.id);
  });
});

// ─── getServerName / promptSpawnName ─────────────────────────────────────────

describe("aws/serverName", () => {
  it("getServerName reads from env", async () => {
    process.env.LIGHTSAIL_SERVER_NAME = "my-test-server";
    const { getServerName } = await import("../aws/aws");
    const name = await getServerName();
    expect(name).toBe("my-test-server");
  });
});

// ─── runServer validation ────────────────────────────────────────────────────

describe("aws/runServer", () => {
  it("rejects empty command", async () => {
    const { runServer } = await import("../aws/aws");
    await expect(runServer("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { runServer } = await import("../aws/aws");
    await expect(runServer("echo\x00hello")).rejects.toThrow("Invalid command");
  });

  it("runs SSH command and resolves on success", async () => {
    const spy = mockBunSpawn(0);
    const { runServer } = await import("../aws/aws");
    await runServer("echo hello", 10);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { runServer } = await import("../aws/aws");
    await expect(runServer("failing-cmd")).rejects.toThrow("run_server failed");
    spy.mockRestore();
  });
});

// ─── uploadFile validation ───────────────────────────────────────────────────

describe("aws/uploadFile", () => {
  it("rejects special characters in path", async () => {
    const { uploadFile } = await import("../aws/aws");
    await expect(uploadFile("/local/file", "/root/bad;rm -rf")).rejects.toThrow("Invalid remote path");
  });

  it("rejects argument injection", async () => {
    const { uploadFile } = await import("../aws/aws");
    await expect(uploadFile("/local/file", "/-evil")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { uploadFile } = await import("../aws/aws");
    await uploadFile("/tmp/local.txt", "/home/ubuntu/file.txt");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { uploadFile } = await import("../aws/aws");
    await expect(uploadFile("/tmp/local.txt", "/home/ubuntu/file.txt")).rejects.toThrow("upload_file failed");
    spy.mockRestore();
  });
});

// ─── downloadFile validation ─────────────────────────────────────────────────

describe("aws/downloadFile", () => {
  it("rejects special characters in path", async () => {
    const { downloadFile } = await import("../aws/aws");
    await expect(downloadFile("/root/bad;rm", "/tmp/out")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../aws/aws");
    await downloadFile("/home/ubuntu/file.txt", "/tmp/out.txt");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("handles $HOME prefix in remote path", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../aws/aws");
    await downloadFile("$HOME/file.txt", "/tmp/out.txt");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── interactiveSession ──────────────────────────────────────────────────────

describe("aws/interactiveSession", () => {
  it("rejects empty command", async () => {
    const { interactiveSession } = await import("../aws/aws");
    await expect(interactiveSession("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { interactiveSession } = await import("../aws/aws");
    await expect(interactiveSession("echo\x00hi")).rejects.toThrow("Invalid command");
  });
});

// ─── destroyServer ───────────────────────────────────────────────────────────

describe("aws/destroyServer", () => {
  it("throws when no name provided and state is empty", async () => {
    const { destroyServer } = await import("../aws/aws");
    await expect(destroyServer()).rejects.toThrow("no instance name");
  });

  it("succeeds via REST when name is given", async () => {
    // Mock fetch for REST path
    global.fetch = mock(() =>
      Promise.resolve(
        new Response("{}", {
          status: 200,
        }),
      ),
    );
    // Set up state for REST mode by assigning env vars
    const spy = mockSpawnSync(1); // no aws cli
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { authenticate, destroyServer } = await import("../aws/aws");
    await authenticate();
    await destroyServer("test-instance");
    spy.mockRestore();
  });
});

// ─── getServerIp ─────────────────────────────────────────────────────────────

describe("aws/getServerIp", () => {
  it("returns null when instance not found (404)", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response('{"message":"Not Found"}', {
          status: 404,
        }),
      ),
    );
    const spy = mockSpawnSync(1); // no aws cli -> REST mode
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { authenticate, getServerIp } = await import("../aws/aws");
    await authenticate();
    const ip = await getServerIp("nonexistent");
    expect(ip).toBeNull();
    spy.mockRestore();
  });
});

// ─── listServers ─────────────────────────────────────────────────────────────

describe("aws/listServers", () => {
  it("returns instances via REST", async () => {
    const apiResp = {
      instances: [
        {
          name: "srv1",
          publicIpAddress: "1.2.3.4",
          state: {
            name: "running",
          },
        },
        {
          name: "srv2",
          state: {
            name: "stopped",
          },
        },
      ],
    };
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(apiResp))));
    const spy = mockSpawnSync(1);
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const { authenticate, listServers } = await import("../aws/aws");
    await authenticate();
    const servers = await listServers();
    expect(servers.length).toBe(2);
    expect(servers[0].name).toBe("srv1");
    expect(servers[0].ip).toBe("1.2.3.4");
    expect(servers[1].ip).toBe("");
    spy.mockRestore();
  });
});
