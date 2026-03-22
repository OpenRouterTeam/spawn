import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockBunSpawn, mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import { DEFAULT_MACHINE_TYPE, DEFAULT_ZONE, getConnectionInfo } from "../gcp/gcp";

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

/** Mock result for `which gcloud` (exitCode 0 = found). */
const WHICH_GCLOUD_OK = {
  exitCode: 0,
  stdout: new TextEncoder().encode("gcloud"),
  stderr: new TextEncoder().encode(""),
  success: true,
  signalCode: null,
  resourceUsage: undefined,
  pid: 1,
} satisfies ReturnType<typeof Bun.spawnSync>;

/**
 * Mock spawnSync so that the first call (which gcloud) succeeds,
 * then the second call returns the given test data.
 */
function mockSpawnSyncWithGcloud(exitCode: number, stdout = "", stderr = "") {
  return spyOn(Bun, "spawnSync")
    .mockReturnValueOnce(WHICH_GCLOUD_OK)
    .mockReturnValueOnce({
      exitCode,
      stdout: new TextEncoder().encode(stdout),
      stderr: new TextEncoder().encode(stderr),
      success: exitCode === 0,
      signalCode: null,
      resourceUsage: undefined,
      pid: 1234,
    } satisfies ReturnType<typeof Bun.spawnSync>);
}

/** Mock spawnSync to only satisfy the `which gcloud` check (for tests that mock Bun.spawn separately). */
function mockWhichGcloud() {
  return spyOn(Bun, "spawnSync").mockReturnValue(WHICH_GCLOUD_OK);
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

// ─── getConnectionInfo ───────────────────────────────────────────────────────

describe("gcp/getConnectionInfo", () => {
  it("returns host and user root", () => {
    const info = getConnectionInfo();
    expect(info.user).toBe("root");
    expect(typeof info.host).toBe("string");
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe("gcp/constants", () => {
  it("DEFAULT_MACHINE_TYPE is e2-medium", () => {
    expect(DEFAULT_MACHINE_TYPE).toBe("e2-medium");
  });
  it("DEFAULT_ZONE is us-central1-a", () => {
    expect(DEFAULT_ZONE).toBe("us-central1-a");
  });
});

// ─── promptMachineType ───────────────────────────────────────────────────────

describe("gcp/promptMachineType", () => {
  it("returns env var when GCP_MACHINE_TYPE is set", async () => {
    process.env.GCP_MACHINE_TYPE = "n2-standard-4";
    const { promptMachineType } = await import("../gcp/gcp");
    const result = await promptMachineType();
    expect(result).toBe("n2-standard-4");
  });

  it("returns default when SPAWN_CUSTOM is not 1", async () => {
    delete process.env.GCP_MACHINE_TYPE;
    delete process.env.SPAWN_CUSTOM;
    const { promptMachineType } = await import("../gcp/gcp");
    const result = await promptMachineType();
    expect(result).toBe(DEFAULT_MACHINE_TYPE);
  });

  it("returns default in non-interactive mode", async () => {
    delete process.env.GCP_MACHINE_TYPE;
    process.env.SPAWN_CUSTOM = "1";
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptMachineType } = await import("../gcp/gcp");
    const result = await promptMachineType();
    expect(result).toBe(DEFAULT_MACHINE_TYPE);
  });
});

// ─── promptZone ──────────────────────────────────────────────────────────────

describe("gcp/promptZone", () => {
  it("returns env var when GCP_ZONE is set", async () => {
    process.env.GCP_ZONE = "europe-west1-b";
    const { promptZone } = await import("../gcp/gcp");
    const result = await promptZone();
    expect(result).toBe("europe-west1-b");
  });

  it("returns default when SPAWN_CUSTOM is not 1", async () => {
    delete process.env.GCP_ZONE;
    delete process.env.SPAWN_CUSTOM;
    const { promptZone } = await import("../gcp/gcp");
    const result = await promptZone();
    expect(result).toBe(DEFAULT_ZONE);
  });

  it("returns default in non-interactive mode", async () => {
    delete process.env.GCP_ZONE;
    process.env.SPAWN_CUSTOM = "1";
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptZone } = await import("../gcp/gcp");
    const result = await promptZone();
    expect(result).toBe(DEFAULT_ZONE);
  });
});

// ─── authenticate ────────────────────────────────────────────────────────────

describe("gcp/authenticate", () => {
  it("succeeds when active account found", async () => {
    // gcloud -> found; auth list -> active account
    const spy = mockSpawnSync(0, "user@example.com\n");
    const { authenticate } = await import("../gcp/gcp");
    await authenticate();
    // spawnSync called to locate gcloud and run auth list
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("launches login when no active account and login succeeds", async () => {
    // 1st call: `which gcloud` for gcloudSync -> requireGcloudCmd
    // 2nd call: `gcloud auth list` returns no active account
    // 3rd call: `which gcloud` for gcloudInteractive -> requireGcloudCmd
    const spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce(WHICH_GCLOUD_OK)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode(""),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce(WHICH_GCLOUD_OK);

    // gcloudInteractive (login) returns 0
    const spawnSpy = mockBunSpawn(0);

    const { authenticate } = await import("../gcp/gcp");
    await authenticate();
    // interactive login was triggered (Bun.spawn called for gcloud auth login)
    expect(spawnSpy).toHaveBeenCalled();
    spawnSyncSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});

// ─── resolveProject ──────────────────────────────────────────────────────────

describe("gcp/resolveProject", () => {
  it("uses GCP_PROJECT from env", async () => {
    process.env.GCP_PROJECT = "my-test-project";
    const spy = mockSpawnSync(0, "/usr/bin/gcloud");
    const { resolveProject } = await import("../gcp/gcp");
    await resolveProject();
    // GCP_PROJECT env var consumed — spawnSync not called for config lookup
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws in non-interactive mode with no project", async () => {
    delete process.env.GCP_PROJECT;
    process.env.SPAWN_NON_INTERACTIVE = "1";
    // gcloud config get-value project returns (unset)
    const spy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("/usr/bin/gcloud"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 1,
      } satisfies ReturnType<typeof Bun.spawnSync>)
      .mockReturnValueOnce({
        exitCode: 0,
        stdout: new TextEncoder().encode("(unset)"),
        stderr: new TextEncoder().encode(""),
        success: true,
        signalCode: null,
        resourceUsage: undefined,
        pid: 2,
      } satisfies ReturnType<typeof Bun.spawnSync>);

    const { resolveProject } = await import("../gcp/gcp");
    await expect(resolveProject()).rejects.toThrow("No GCP project");
    spy.mockRestore();
  });
});

// ─── getServerName ───────────────────────────────────────────────────────────

describe("gcp/getServerName", () => {
  it("reads from GCP_INSTANCE_NAME env", async () => {
    process.env.GCP_INSTANCE_NAME = "test-gcp-instance";
    const { getServerName } = await import("../gcp/gcp");
    const name = await getServerName();
    expect(name).toBe("test-gcp-instance");
  });
});

// ─── runServer ───────────────────────────────────────────────────────────────

describe("gcp/runServer", () => {
  it("rejects empty command", async () => {
    const { runServer } = await import("../gcp/gcp");
    await expect(runServer("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { runServer } = await import("../gcp/gcp");
    await expect(runServer("echo\x00hi")).rejects.toThrow("Invalid command");
  });

  it("runs SSH command successfully", async () => {
    const spy = mockBunSpawn(0);
    const { runServer } = await import("../gcp/gcp");
    await runServer("echo hello", 10);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { runServer } = await import("../gcp/gcp");
    await expect(runServer("failing")).rejects.toThrow("run_server failed");
    spy.mockRestore();
  });
});

// ─── uploadFile ──────────────────────────────────────────────────────────────

describe("gcp/uploadFile", () => {
  it("rejects invalid local path (empty)", async () => {
    const { uploadFile } = await import("../gcp/gcp");
    await expect(uploadFile("", "/remote/file")).rejects.toThrow("Invalid local path");
  });

  it("rejects local path traversal", async () => {
    const { uploadFile } = await import("../gcp/gcp");
    await expect(uploadFile("../bad", "/remote/file")).rejects.toThrow("Invalid local path");
  });

  it("rejects local path argument injection", async () => {
    const { uploadFile } = await import("../gcp/gcp");
    await expect(uploadFile("-evil", "/remote/file")).rejects.toThrow("Invalid local path");
  });

  it("rejects invalid remote path", async () => {
    const { uploadFile } = await import("../gcp/gcp");
    await expect(uploadFile("/tmp/local", "/root/bad;rm")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { uploadFile } = await import("../gcp/gcp");
    await uploadFile("/tmp/local.txt", "/root/file.txt");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── downloadFile ────────────────────────────────────────────────────────────

describe("gcp/downloadFile", () => {
  it("rejects invalid local path", async () => {
    const { downloadFile } = await import("../gcp/gcp");
    await expect(downloadFile("/root/file", "")).rejects.toThrow("Invalid local path");
  });

  it("rejects invalid remote path", async () => {
    const { downloadFile } = await import("../gcp/gcp");
    await expect(downloadFile("/root/bad;rm", "/tmp/out")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../gcp/gcp");
    await downloadFile("/root/file.txt", "/tmp/out.txt");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── interactiveSession ──────────────────────────────────────────────────────

describe("gcp/interactiveSession", () => {
  it("rejects empty command", async () => {
    const { interactiveSession } = await import("../gcp/gcp");
    await expect(interactiveSession("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { interactiveSession } = await import("../gcp/gcp");
    await expect(interactiveSession("echo\x00hi")).rejects.toThrow("Invalid command");
  });
});

// ─── getServerIp ─────────────────────────────────────────────────────────────

describe("gcp/getServerIp", () => {
  it("returns null when instance not found", async () => {
    const spy = mockSpawnSyncWithGcloud(
      1,
      "",
      "ERROR: (gcloud.compute.instances.describe) Could not fetch resource: - The resource was not found",
    );
    const { getServerIp } = await import("../gcp/gcp");
    const ip = await getServerIp("nonexistent", "us-central1-a", "my-project");
    expect(ip).toBeNull();
    spy.mockRestore();
  });

  it("returns IP when instance exists", async () => {
    const spy = mockSpawnSyncWithGcloud(0, "10.20.30.40");
    const { getServerIp } = await import("../gcp/gcp");
    const ip = await getServerIp("my-instance", "us-central1-a", "my-project");
    expect(ip).toBe("10.20.30.40");
    spy.mockRestore();
  });

  it("returns null when IP is empty", async () => {
    const spy = mockSpawnSyncWithGcloud(0, "");
    const { getServerIp } = await import("../gcp/gcp");
    const ip = await getServerIp("my-instance", "us-central1-a", "my-project");
    expect(ip).toBeNull();
    spy.mockRestore();
  });

  it("throws on non-404 errors", async () => {
    const spy = mockSpawnSyncWithGcloud(1, "", "Permission denied");
    const { getServerIp } = await import("../gcp/gcp");
    await expect(getServerIp("my-instance", "us-central1-a", "my-project")).rejects.toThrow("GCP API error");
    spy.mockRestore();
  });
});

// ─── listServers ─────────────────────────────────────────────────────────────

describe("gcp/listServers", () => {
  it("returns empty array on failure", async () => {
    const whichSpy = mockWhichGcloud();
    const spy = mockBunSpawn(1);
    const { listServers } = await import("../gcp/gcp");
    const result = await listServers("us-central1-a", "my-project");
    expect(result).toEqual([]);
    spy.mockRestore();
    whichSpy.mockRestore();
  });

  it("parses instance list correctly", async () => {
    const data = [
      {
        name: "vm1",
        status: "RUNNING",
        networkInterfaces: [
          {
            accessConfigs: [
              {
                natIP: "1.2.3.4",
              },
            ],
          },
        ],
      },
      {
        name: "vm2",
        status: "STOPPED",
        networkInterfaces: [
          {
            accessConfigs: [
              {},
            ],
          },
        ],
      },
    ];
    const whichSpy = mockWhichGcloud();
    const spy = mockBunSpawn(0, JSON.stringify(data));
    const { listServers } = await import("../gcp/gcp");
    const result = await listServers("us-central1-a", "my-project");
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("vm1");
    expect(result[0].ip).toBe("1.2.3.4");
    expect(result[1].ip).toBe("");
    spy.mockRestore();
    whichSpy.mockRestore();
  });

  it("returns empty array for non-array JSON", async () => {
    const whichSpy = mockWhichGcloud();
    const spy = mockBunSpawn(0, '{"not": "array"}');
    const { listServers } = await import("../gcp/gcp");
    const result = await listServers("us-central1-a", "my-project");
    expect(result).toEqual([]);
    spy.mockRestore();
    whichSpy.mockRestore();
  });
});

// ─── destroyInstance ─────────────────────────────────────────────────────────

describe("gcp/destroyInstance", () => {
  it("throws when no instance name", async () => {
    const { destroyInstance } = await import("../gcp/gcp");
    await expect(destroyInstance()).rejects.toThrow("No instance name");
  });

  it("succeeds when gcloud delete returns 0", async () => {
    const spy = mockBunSpawn(0);
    const mockSync = mockSpawnSync(0, "/usr/bin/gcloud");
    const { destroyInstance } = await import("../gcp/gcp");
    await destroyInstance("test-vm");
    // Bun.spawn called to run gcloud instances delete
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    mockSync.mockRestore();
  });

  it("throws when gcloud delete fails", async () => {
    const spy = mockBunSpawn(1, "", "delete failed");
    const mockSync = mockSpawnSync(0, "/usr/bin/gcloud");
    const { destroyInstance } = await import("../gcp/gcp");
    await expect(destroyInstance("test-vm")).rejects.toThrow("Instance deletion failed");
    spy.mockRestore();
    mockSync.mockRestore();
  });
});

// ─── ensureGcloudCli ─────────────────────────────────────────────────────────

describe("gcp/ensureGcloudCli", () => {
  it("does nothing when gcloud already available", async () => {
    const spy = mockSpawnSync(0, "/usr/bin/gcloud");
    const { ensureGcloudCli } = await import("../gcp/gcp");
    await ensureGcloudCli();
    // spawnSync called once to locate gcloud — no install triggered
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ─── checkBillingEnabled ─────────────────────────────────────────────────────

describe("gcp/checkBillingEnabled", () => {
  it("returns immediately when no project set", async () => {
    // Force no project
    delete process.env.GCP_PROJECT;
    // Mock spawnSync to handle case where _state.project was set by prior tests
    // (module-level state persists across tests due to import caching)
    const spy = mockSpawnSyncWithGcloud(0, "true");
    const fetchMock = mock(() => Promise.resolve(new Response("{}")));
    global.fetch = fetchMock;
    const { checkBillingEnabled } = await import("../gcp/gcp");
    await checkBillingEnabled();
    // fetch not called — billing check skipped when no project
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
