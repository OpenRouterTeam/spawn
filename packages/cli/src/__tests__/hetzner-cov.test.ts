import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockBunSpawn, mockClackPrompts } from "./test-helpers";

mockClackPrompts();

import {
  cleanupOrphanedPrimaryIps,
  DEFAULT_LOCATION,
  DEFAULT_SERVER_TYPE,
  getConnectionInfo,
  isResourceLimitError,
} from "../hetzner/hetzner";

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

  it("cleans up orphaned primary IPs on resource_limit_exceeded and retries", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    const serverResp = {
      server: {
        id: 99,
        public_net: {
          ipv4: {
            ip: "10.0.0.5",
          },
        },
      },
    };
    // URL-aware mock: route responses by URL pattern so concurrent test files
    // leaking extra fetch calls don't corrupt the sequential callCount routing.
    let postServersCount = 0;
    let callCount = 0;
    global.fetch = mock((input: string | URL | Request) => {
      callCount++;
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : "GET";

      if (url.includes("/servers") && url.includes("per_page=1")) {
        // Token validation
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      if (url.includes("/ssh_keys")) {
        // SSH key listing
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ssh_keys: [],
            }),
          ),
        );
      }
      if (url.includes("/primary_ips") && method === "DELETE") {
        // Delete orphaned primary IP
        return Promise.resolve(
          new Response("", {
            status: 204,
          }),
        );
      }
      if (url.includes("/primary_ips")) {
        // List primary IPs for cleanup
        return Promise.resolve(
          new Response(
            JSON.stringify({
              primary_ips: [
                {
                  id: 100,
                  ip: "1.2.3.4",
                  assignee_id: 0,
                },
                {
                  id: 200,
                  ip: "5.6.7.8",
                  assignee_id: 42,
                },
              ],
            }),
          ),
        );
      }
      if (url.includes("/servers")) {
        // POST /servers — first attempt fails, retry succeeds
        postServersCount++;
        if (postServersCount === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "resource_limit_exceeded",
                  message: "primary_ip_limit",
                },
              }),
              {
                status: 403,
              },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify(serverResp)));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    const { ensureHcloudToken, createServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const conn = await createServer("test-retry", "cx23", "fsn1");
    expect(conn.ip).toBe("10.0.0.5");
    // Should have called: token, ssh_keys, create-fail, list-ips, delete-ip, create-ok
    expect(callCount).toBeGreaterThanOrEqual(6);
  });

  it("throws with guidance when resource limit hit and no orphaned IPs to clean", async () => {
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
      if (callCount <= 2) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ssh_keys: [],
            }),
          ),
        );
      }
      if (callCount <= 3) {
        // Create fails with resource_limit_exceeded
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "resource_limit_exceeded",
                message: "primary_ip_limit",
              },
            }),
            {
              status: 403,
            },
          ),
        );
      }
      // List primary IPs — all attached (none orphaned)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            primary_ips: [
              {
                id: 100,
                ip: "1.2.3.4",
                assignee_id: 42,
              },
            ],
          }),
        ),
      );
    });
    const { ensureHcloudToken, createServer } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    await expect(createServer("test-noclean", "cx23", "fsn1")).rejects.toThrow("resource_limit_exceeded");
    // Verify guidance was printed
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("Primary IP limit");
    expect(output).toContain("quota increase");
  });
});

// ─── isResourceLimitError ─────────────────────────────────────────────────

describe("hetzner/isResourceLimitError", () => {
  it("detects resource_limit_exceeded", () => {
    expect(isResourceLimitError("resource_limit_exceeded")).toBe(true);
  });
  it("detects primary_ip_limit", () => {
    expect(isResourceLimitError("primary_ip_limit")).toBe(true);
  });
  it("detects mixed-case and substring", () => {
    expect(isResourceLimitError("Error: Resource_Limit_Exceeded for account")).toBe(true);
  });
  it("returns false for unrelated errors", () => {
    expect(isResourceLimitError("server not found")).toBe(false);
    expect(isResourceLimitError("insufficient funds")).toBe(false);
  });
});

// ─── cleanupOrphanedPrimaryIps ──────────────────────────────────────────────

describe("hetzner/cleanupOrphanedPrimaryIps", () => {
  it("deletes only unattached primary IPs", async () => {
    process.env.HCLOUD_TOKEN = "test-token";
    let callCount = 0;
    const deletedIds: string[] = [];
    global.fetch = mock((url: string, opts?: RequestInit) => {
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
        // List primary IPs
        return Promise.resolve(
          new Response(
            JSON.stringify({
              primary_ips: [
                {
                  id: 10,
                  ip: "1.1.1.1",
                  assignee_id: 0,
                },
                {
                  id: 20,
                  ip: "2.2.2.2",
                  assignee_id: 5,
                },
                {
                  id: 30,
                  ip: "3.3.3.3",
                  assignee_id: 0,
                },
              ],
            }),
          ),
        );
      }
      // DELETE calls
      if (opts?.method === "DELETE") {
        const idMatch = String(url).match(/primary_ips\/(\d+)/);
        if (idMatch) {
          deletedIds.push(idMatch[1]);
        }
        return Promise.resolve(
          new Response("", {
            status: 204,
          }),
        );
      }
      return Promise.resolve(new Response("{}"));
    });
    const { ensureHcloudToken } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const count = await cleanupOrphanedPrimaryIps();
    expect(count).toBe(2);
    expect(deletedIds).toContain("10");
    expect(deletedIds).toContain("30");
    expect(deletedIds).not.toContain("20");
  });

  it("returns 0 when no orphaned IPs exist", async () => {
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
            primary_ips: [
              {
                id: 10,
                ip: "1.1.1.1",
                assignee_id: 5,
              },
            ],
          }),
        ),
      );
    });
    const { ensureHcloudToken } = await import("../hetzner/hetzner");
    await ensureHcloudToken();
    const count = await cleanupOrphanedPrimaryIps();
    expect(count).toBe(0);
  });
});
