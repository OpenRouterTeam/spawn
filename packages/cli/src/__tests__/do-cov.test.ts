import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockBunSpawn, mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import { DEFAULT_DO_REGION, DEFAULT_DROPLET_SIZE, getConnectionInfo } from "../digitalocean/digitalocean";

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

describe("digitalocean/getConnectionInfo", () => {
  it("returns host and user root", () => {
    const info = getConnectionInfo();
    expect(info.user).toBe("root");
    expect(typeof info.host).toBe("string");
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe("digitalocean/constants", () => {
  it("DEFAULT_DROPLET_SIZE is s-2vcpu-2gb", () => {
    expect(DEFAULT_DROPLET_SIZE).toBe("s-2vcpu-2gb");
  });
  it("DEFAULT_DO_REGION is nyc3", () => {
    expect(DEFAULT_DO_REGION).toBe("nyc3");
  });
});

// ─── promptDropletSize ───────────────────────────────────────────────────────

describe("digitalocean/promptDropletSize", () => {
  it("returns env var when DO_DROPLET_SIZE is set", async () => {
    process.env.DO_DROPLET_SIZE = "s-4vcpu-8gb";
    const { promptDropletSize } = await import("../digitalocean/digitalocean");
    const result = await promptDropletSize();
    expect(result).toBe("s-4vcpu-8gb");
  });

  it("returns default when SPAWN_CUSTOM is not 1", async () => {
    delete process.env.DO_DROPLET_SIZE;
    delete process.env.SPAWN_CUSTOM;
    const { promptDropletSize } = await import("../digitalocean/digitalocean");
    const result = await promptDropletSize();
    expect(result).toBe(DEFAULT_DROPLET_SIZE);
  });

  it("returns default in non-interactive mode", async () => {
    delete process.env.DO_DROPLET_SIZE;
    process.env.SPAWN_CUSTOM = "1";
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptDropletSize } = await import("../digitalocean/digitalocean");
    const result = await promptDropletSize();
    expect(result).toBe(DEFAULT_DROPLET_SIZE);
  });
});

// ─── promptDoRegion ──────────────────────────────────────────────────────────

describe("digitalocean/promptDoRegion", () => {
  it("returns env var when DO_REGION is set", async () => {
    process.env.DO_REGION = "sfo3";
    const { promptDoRegion } = await import("../digitalocean/digitalocean");
    const result = await promptDoRegion();
    expect(result).toBe("sfo3");
  });

  it("returns default when SPAWN_CUSTOM is not 1", async () => {
    delete process.env.DO_REGION;
    delete process.env.SPAWN_CUSTOM;
    const { promptDoRegion } = await import("../digitalocean/digitalocean");
    const result = await promptDoRegion();
    expect(result).toBe(DEFAULT_DO_REGION);
  });

  it("returns default in non-interactive mode", async () => {
    delete process.env.DO_REGION;
    process.env.SPAWN_CUSTOM = "1";
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptDoRegion } = await import("../digitalocean/digitalocean");
    const result = await promptDoRegion();
    expect(result).toBe(DEFAULT_DO_REGION);
  });
});

// ─── getServerName ───────────────────────────────────────────────────────────

describe("digitalocean/getServerName", () => {
  it("reads from DO_DROPLET_NAME env", async () => {
    process.env.DO_DROPLET_NAME = "test-droplet";
    const { getServerName } = await import("../digitalocean/digitalocean");
    const name = await getServerName();
    expect(name).toBe("test-droplet");
  });
});

// ─── promptSpawnName ─────────────────────────────────────────────────────────

describe("digitalocean/promptSpawnName", () => {
  it("returns early when SPAWN_NAME_KEBAB already set", async () => {
    process.env.SPAWN_NAME_KEBAB = "existing-name";
    const { promptSpawnName } = await import("../digitalocean/digitalocean");
    await promptSpawnName();
    // Should not throw or change env
  });

  it("uses DO_DROPLET_NAME when valid", async () => {
    delete process.env.SPAWN_NAME_KEBAB;
    process.env.DO_DROPLET_NAME = "my-valid-droplet";
    const { promptSpawnName } = await import("../digitalocean/digitalocean");
    await promptSpawnName();
    expect(process.env.SPAWN_NAME_KEBAB).toBe("my-valid-droplet");
  });

  it("uses default in non-interactive mode", async () => {
    delete process.env.SPAWN_NAME_KEBAB;
    delete process.env.DO_DROPLET_NAME;
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptSpawnName } = await import("../digitalocean/digitalocean");
    await promptSpawnName();
    expect(process.env.SPAWN_NAME_KEBAB).toBeTruthy();
  });
});

// ─── runServer ───────────────────────────────────────────────────────────────

describe("digitalocean/runServer", () => {
  it("rejects empty command", async () => {
    const { runServer } = await import("../digitalocean/digitalocean");
    await expect(runServer("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { runServer } = await import("../digitalocean/digitalocean");
    await expect(runServer("echo\x00hi")).rejects.toThrow("Invalid command");
  });

  it("runs SSH command and resolves on success", async () => {
    const spy = mockBunSpawn(0);
    const { runServer } = await import("../digitalocean/digitalocean");
    await runServer("echo hello", 10, "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("wraps command with bash -c and shellQuote to prevent injection", async () => {
    const spy = mockBunSpawn(0);
    const { runServer } = await import("../digitalocean/digitalocean");
    await runServer("echo hello", 10, "1.2.3.4");
    const args = spy.mock.calls[0][0];
    const sshCmd = args[args.length - 1];
    expect(sshCmd).toMatch(/^bash -c '/);
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { runServer } = await import("../digitalocean/digitalocean");
    await expect(runServer("failing-cmd", undefined, "1.2.3.4")).rejects.toThrow("run_server failed");
    spy.mockRestore();
  });
});

// ─── uploadFile ──────────────────────────────────────────────────────────────

describe("digitalocean/uploadFile", () => {
  it("rejects path traversal in remote path", async () => {
    const { uploadFile } = await import("../digitalocean/digitalocean");
    await expect(uploadFile("/local/file", "/root/bad;rm")).rejects.toThrow("Invalid remote path");
  });

  it("rejects argument injection in remote path", async () => {
    const { uploadFile } = await import("../digitalocean/digitalocean");
    await expect(uploadFile("/local/file", "/-evil")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { uploadFile } = await import("../digitalocean/digitalocean");
    await uploadFile("/tmp/local.txt", "/root/file.txt", "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { uploadFile } = await import("../digitalocean/digitalocean");
    await expect(uploadFile("/tmp/local.txt", "/root/file.txt", "1.2.3.4")).rejects.toThrow("upload_file failed");
    spy.mockRestore();
  });
});

// ─── downloadFile ────────────────────────────────────────────────────────────

describe("digitalocean/downloadFile", () => {
  it("rejects path traversal", async () => {
    const { downloadFile } = await import("../digitalocean/digitalocean");
    await expect(downloadFile("/root/bad;rm", "/tmp/out")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../digitalocean/digitalocean");
    await downloadFile("/root/file.txt", "/tmp/out.txt", "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("handles $HOME prefix", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../digitalocean/digitalocean");
    await downloadFile("$HOME/file.txt", "/tmp/out.txt", "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── interactiveSession ──────────────────────────────────────────────────────

describe("digitalocean/interactiveSession", () => {
  it("rejects empty command", async () => {
    const { interactiveSession } = await import("../digitalocean/digitalocean");
    await expect(interactiveSession("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { interactiveSession } = await import("../digitalocean/digitalocean");
    await expect(interactiveSession("echo\x00hi")).rejects.toThrow("Invalid command");
  });
});

// ─── destroyServer ───────────────────────────────────────────────────────────

describe("digitalocean/destroyServer", () => {
  it("throws when no droplet ID provided", async () => {
    const { destroyServer } = await import("../digitalocean/digitalocean");
    await expect(destroyServer()).rejects.toThrow("No droplet ID");
  });
});

// ─── getServerIp ─────────────────────────────────────────────────────────────

describe("digitalocean/getServerIp", () => {
  it("returns null when droplet not found (404)", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response('{"id":"not_found","message":"The resource you requested could not be found."}', {
          status: 404,
        }),
      ),
    );
    const { getServerIp } = await import("../digitalocean/digitalocean");
    // Need to set the token state
    process.env.DO_API_TOKEN = "test-token";
    // getServerIp calls doApi which uses internal state token - need to set via ensureDoToken
    // But doApi will use _state.token. Since we can't easily set _state, we test the 404 path
    // by mocking fetch to always return 404
    const ip = await getServerIp("99999");
    expect(ip).toBeNull();
  });

  it("returns IP when droplet found with public network", async () => {
    const resp = {
      droplet: {
        id: 12345,
        networks: {
          v4: [
            {
              type: "public",
              ip_address: "10.20.30.40",
            },
          ],
        },
      },
    };
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(resp))));
    const { getServerIp } = await import("../digitalocean/digitalocean");
    const ip = await getServerIp("12345");
    expect(ip).toBe("10.20.30.40");
  });

  it("returns null when no public network", async () => {
    const resp = {
      droplet: {
        id: 12345,
        networks: {
          v4: [
            {
              type: "private",
              ip_address: "10.0.0.1",
            },
          ],
        },
      },
    };
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(resp))));
    const { getServerIp } = await import("../digitalocean/digitalocean");
    const ip = await getServerIp("12345");
    expect(ip).toBeNull();
  });
});

// ─── listServers ─────────────────────────────────────────────────────────────

describe("digitalocean/listServers", () => {
  it("returns droplet list", async () => {
    const resp = {
      droplets: [
        {
          id: 1,
          name: "droplet-1",
          status: "active",
          networks: {
            v4: [
              {
                type: "public",
                ip_address: "1.2.3.4",
              },
            ],
          },
        },
        {
          id: 2,
          name: "droplet-2",
          status: "off",
          networks: {
            v4: [],
          },
        },
      ],
    };
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(resp))));
    const { listServers } = await import("../digitalocean/digitalocean");
    const servers = await listServers();
    expect(servers.length).toBe(2);
    expect(servers[0].name).toBe("droplet-1");
    expect(servers[0].ip).toBe("1.2.3.4");
    expect(servers[1].ip).toBe("");
  });
});

// ─── promptSwitchAccount ─────────────────────────────────────────────────────

describe("digitalocean/promptSwitchAccount", () => {
  it("returns false in non-interactive mode", async () => {
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptSwitchAccount } = await import("../digitalocean/digitalocean");
    const result = await promptSwitchAccount();
    expect(result).toBe(false);
  });
});

// ─── checkAccountStatus ──────────────────────────────────────────────────────

describe("digitalocean/checkAccountStatus", () => {
  it("returns immediately when no token", async () => {
    const { checkAccountStatus } = await import("../digitalocean/digitalocean");
    // _state.token is empty by default
    await checkAccountStatus();
  });
});
