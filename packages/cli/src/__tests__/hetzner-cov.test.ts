import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockBunSpawn, mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import { DEFAULT_LOCATION, DEFAULT_SERVER_TYPE, getConnectionInfo } from "../hetzner/hetzner";

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

describe("hetzner/getConnectionInfo", () => {
  it("returns host and user root", () => {
    const info = getConnectionInfo();
    expect(info.user).toBe("root");
    expect(typeof info.host).toBe("string");
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe("hetzner/constants", () => {
  it("DEFAULT_SERVER_TYPE is cx23", () => {
    expect(DEFAULT_SERVER_TYPE).toBe("cx23");
  });
  it("DEFAULT_LOCATION is nbg1", () => {
    expect(DEFAULT_LOCATION).toBe("nbg1");
  });
});

// ─── promptServerType ────────────────────────────────────────────────────────

describe("hetzner/promptServerType", () => {
  it("returns env var when HETZNER_SERVER_TYPE is set", async () => {
    process.env.HETZNER_SERVER_TYPE = "cpx32";
    const { promptServerType } = await import("../hetzner/hetzner");
    const result = await promptServerType();
    expect(result).toBe("cpx32");
  });

  it("returns default when SPAWN_CUSTOM is not 1", async () => {
    delete process.env.HETZNER_SERVER_TYPE;
    delete process.env.SPAWN_CUSTOM;
    const { promptServerType } = await import("../hetzner/hetzner");
    const result = await promptServerType();
    expect(result).toBe(DEFAULT_SERVER_TYPE);
  });

  it("returns default in non-interactive mode", async () => {
    delete process.env.HETZNER_SERVER_TYPE;
    process.env.SPAWN_CUSTOM = "1";
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptServerType } = await import("../hetzner/hetzner");
    const result = await promptServerType();
    expect(result).toBe(DEFAULT_SERVER_TYPE);
  });
});

// ─── promptLocation ──────────────────────────────────────────────────────────

describe("hetzner/promptLocation", () => {
  it("returns env var when HETZNER_LOCATION is set", async () => {
    process.env.HETZNER_LOCATION = "hel1";
    const { promptLocation } = await import("../hetzner/hetzner");
    const result = await promptLocation();
    expect(result).toBe("hel1");
  });

  it("returns default when SPAWN_CUSTOM is not 1", async () => {
    delete process.env.HETZNER_LOCATION;
    delete process.env.SPAWN_CUSTOM;
    const { promptLocation } = await import("../hetzner/hetzner");
    const result = await promptLocation();
    expect(result).toBe(DEFAULT_LOCATION);
  });

  it("returns default in non-interactive mode", async () => {
    delete process.env.HETZNER_LOCATION;
    process.env.SPAWN_CUSTOM = "1";
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { promptLocation } = await import("../hetzner/hetzner");
    const result = await promptLocation();
    expect(result).toBe(DEFAULT_LOCATION);
  });
});

// ─── getServerName ───────────────────────────────────────────────────────────

describe("hetzner/getServerName", () => {
  it("reads from HETZNER_SERVER_NAME env", async () => {
    process.env.HETZNER_SERVER_NAME = "test-hetzner-server";
    const { getServerName } = await import("../hetzner/hetzner");
    const name = await getServerName();
    expect(name).toBe("test-hetzner-server");
  });
});

// ─── ensureHcloudToken ───────────────────────────────────────────────────────

describe("hetzner/ensureHcloudToken", () => {
  it("uses HCLOUD_TOKEN from env when valid", async () => {
    process.env.HCLOUD_TOKEN = "test-hcloud-token";
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            servers: [],
          }),
        ),
      ),
    );
    global.fetch = fetchMock;
    const { ensureHcloudToken } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    // fetch called to validate the token against Hetzner API
    expect(fetchMock).toHaveBeenCalled();
  });

  it("warns when HCLOUD_TOKEN is invalid", async () => {
    process.env.HCLOUD_TOKEN = "bad-token";
    // Token validation fails
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "unauthorized",
            },
          }),
        ),
      ),
    );
    // Will fall through to saved config, then manual entry
    // Set non-interactive to skip manual entry
    process.env.SPAWN_NON_INTERACTIVE = "1";
    const { ensureHcloudToken } = await import("../hetzner/hetzner");
    // Should eventually throw after 3 attempts (but non-interactive will fail prompt)
    await expect(ensureHcloudToken()).rejects.toThrow();
  });
});

// ─── runServer ───────────────────────────────────────────────────────────────

describe("hetzner/runServer", () => {
  it("rejects empty command", async () => {
    const { runServer } = await import("../hetzner/hetzner");
    await expect(runServer("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { runServer } = await import("../hetzner/hetzner");
    await expect(runServer("echo\x00hi")).rejects.toThrow("Invalid command");
  });

  it("runs SSH command and resolves on success", async () => {
    const spy = mockBunSpawn(0);
    const { runServer } = await import("../hetzner/hetzner");
    await runServer("echo hello", 10, "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("wraps command with bash -c and shellQuote to prevent injection", async () => {
    const spy = mockBunSpawn(0);
    const { runServer } = await import("../hetzner/hetzner");
    await runServer("echo hello", 10, "1.2.3.4");
    const args = spy.mock.calls[0][0];
    const sshCmd = args[args.length - 1];
    expect(sshCmd).toContain("bash -c 'echo hello'");
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { runServer } = await import("../hetzner/hetzner");
    await expect(runServer("failing", undefined, "1.2.3.4")).rejects.toThrow("run_server failed");
    spy.mockRestore();
  });
});

// ─── uploadFile ──────────────────────────────────────────────────────────────

describe("hetzner/uploadFile", () => {
  it("rejects path traversal in remote path", async () => {
    const { uploadFile } = await import("../hetzner/hetzner");
    await expect(uploadFile("/local/file", "/root/bad;rm")).rejects.toThrow("Invalid remote path");
  });

  it("rejects argument injection", async () => {
    const { uploadFile } = await import("../hetzner/hetzner");
    await expect(uploadFile("/local/file", "/-evil")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { uploadFile } = await import("../hetzner/hetzner");
    await uploadFile("/tmp/local.txt", "/root/file.txt", "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws on non-zero exit", async () => {
    const spy = mockBunSpawn(1);
    const { uploadFile } = await import("../hetzner/hetzner");
    await expect(uploadFile("/tmp/local.txt", "/root/file.txt", "1.2.3.4")).rejects.toThrow("upload_file failed");
    spy.mockRestore();
  });
});

// ─── downloadFile ────────────────────────────────────────────────────────────

describe("hetzner/downloadFile", () => {
  it("rejects path traversal", async () => {
    const { downloadFile } = await import("../hetzner/hetzner");
    await expect(downloadFile("/root/bad;rm", "/tmp/out")).rejects.toThrow("Invalid remote path");
  });

  it("succeeds for valid paths", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../hetzner/hetzner");
    await downloadFile("/root/file.txt", "/tmp/out.txt", "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("handles $HOME prefix", async () => {
    const spy = mockBunSpawn(0);
    const { downloadFile } = await import("../hetzner/hetzner");
    await downloadFile("$HOME/file.txt", "/tmp/out.txt", "1.2.3.4");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── interactiveSession ──────────────────────────────────────────────────────

describe("hetzner/interactiveSession", () => {
  it("rejects empty command", async () => {
    const { interactiveSession } = await import("../hetzner/hetzner");
    await expect(interactiveSession("")).rejects.toThrow("Invalid command");
  });

  it("rejects null byte in command", async () => {
    const { interactiveSession } = await import("../hetzner/hetzner");
    await expect(interactiveSession("echo\x00hi")).rejects.toThrow("Invalid command");
  });
});

// ─── destroyServer ───────────────────────────────────────────────────────────

describe("hetzner/destroyServer", () => {
  it("throws when no server ID provided", async () => {
    const { destroyServer } = await import("../hetzner/hetzner");
    await expect(destroyServer()).rejects.toThrow("No server ID");
  });

  it("succeeds when API returns action", async () => {
    // Need to set token first
    process.env.HCLOUD_TOKEN = "test-token";
    const tokenResp = JSON.stringify({
      servers: [],
    });
    // First call = token validation, then destroy
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(new Response(tokenResp));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            action: {
              id: 1,
              status: "running",
            },
          }),
        ),
      );
    });
    global.fetch = fetchMock;
    const { ensureHcloudToken, destroyServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    await destroyServer("12345");
    // fetch called at least twice: once for token validation, once for delete
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("throws when API returns error", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "not found",
            },
          }),
        ),
      );
    });
    const { ensureHcloudToken, destroyServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    await expect(destroyServer("99999")).rejects.toThrow("Server deletion failed");
  });
});

// ─── getServerIp ─────────────────────────────────────────────────────────────

describe("hetzner/getServerIp", () => {
  it("returns null when server not found (404)", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response("not found 404", {
          status: 404,
        }),
      );
    });
    const { ensureHcloudToken, getServerIp } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const ip = await getServerIp("99999");
    expect(ip).toBeNull();
  });

  it("returns IP when server found", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    let callCount = 0;
    const serverResp = {
      server: {
        id: 12345,
        public_net: {
          ipv4: {
            ip: "10.20.30.40",
          },
        },
      },
    };
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(serverResp)));
    });
    const { ensureHcloudToken, getServerIp } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const ip = await getServerIp("12345");
    expect(ip).toBe("10.20.30.40");
  });

  it("returns null when no server in response", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    const { ensureHcloudToken, getServerIp } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const ip = await getServerIp("12345");
    expect(ip).toBeNull();
  });
});

// ─── listServers ─────────────────────────────────────────────────────────────

describe("hetzner/listServers", () => {
  it("returns server list", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const resp = {
      servers: [
        {
          id: 1,
          name: "server-1",
          status: "running",
          public_net: {
            ipv4: {
              ip: "1.2.3.4",
            },
          },
        },
        {
          id: 2,
          name: "server-2",
          status: "off",
          public_net: {
            ipv4: {},
          },
        },
      ],
    };
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(resp)));
    });
    const { ensureHcloudToken, listServers } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const servers = await listServers();
    expect(servers.length).toBe(2);
    expect(servers[0].name).toBe("server-1");
    expect(servers[0].ip).toBe("1.2.3.4");
    expect(servers[1].ip).toBe("");
  });
});

// ─── createServer ────────────────────────────────────────────────────────────

describe("hetzner/createServer", () => {
  it("throws on invalid location", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            servers: [],
            ssh_keys: [],
          }),
        ),
      );
    });
    const { ensureHcloudToken, createServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    await expect(createServer("test", "cx23", "bad location!!")).rejects.toThrow("Invalid location");
  });

  it("succeeds when API returns server", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const serverResp = {
      server: {
        id: 12345,
        public_net: {
          ipv4: {
            ip: "10.0.0.1",
          },
        },
      },
    };
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        // Token validation
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      if (callCount <= 2) {
        // SSH keys pagination
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ssh_keys: [
                {
                  id: 1,
                },
              ],
            }),
          ),
        );
      }
      // Create server
      return Promise.resolve(new Response(JSON.stringify(serverResp)));
    });
    const { ensureHcloudToken, createServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const conn = await createServer("test-server", "cx23", "fsn1");
    expect(conn.ip).toBe("10.0.0.1");
    expect(conn.cloud).toBe("hetzner");
    expect(conn.server_name).toBe("test-server");
  });

  it("throws when server IP is missing", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const serverResp = {
      server: {
        id: 12345,
        public_net: {
          ipv4: {},
        },
      },
    };
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      if (callCount <= 2) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ssh_keys: [],
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(serverResp)));
    });
    const { ensureHcloudToken, createServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    await expect(createServer("test-server", "cx23", "fsn1")).rejects.toThrow("No server IP");
  });
});
