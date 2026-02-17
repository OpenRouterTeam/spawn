import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HetznerProvider } from "../providers/hetzner.js";
import { CloudAPIError } from "../cloud-provider.js";

describe("HetznerProvider", () => {
  let provider: HetznerProvider;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    provider = new HetznerProvider();
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(handlers: Record<string, { status: number; body: unknown }>) {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      fetchCalls.push({ url: urlStr, init: init ?? {} });

      for (const [pattern, response] of Object.entries(handlers)) {
        if (urlStr.includes(pattern)) {
          return new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({ error: "unhandled" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  describe("metadata", () => {
    it("has correct label and id", () => {
      expect(provider.label).toBe("Hetzner Cloud");
      expect(provider.id).toBe("hetzner");
    });
  });

  describe("authenticate", () => {
    it("validates token against the API", async () => {
      mockFetch({
        "/servers": { status: 200, body: { servers: [] } },
      });

      await provider.authenticate({ token: "valid-token" });

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain("api.hetzner.cloud/v1/servers");
      const headers = fetchCalls[0].init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer valid-token");
    });

    it("throws descriptive error on invalid token", async () => {
      mockFetch({
        "/servers": { status: 401, body: { error: { message: "unauthorized" } } },
      });

      await expect(provider.authenticate({ token: "bad-token" })).rejects.toThrow(
        /Hetzner authentication failed.*Verify your token/,
      );
    });
  });

  describe("ensureSSHKey", () => {
    it("returns existing key ID if key already registered", async () => {
      mockFetch({
        "/ssh_keys": {
          status: 200,
          body: {
            ssh_keys: [
              { id: 42, name: "spawn-key", fingerprint: "aa:bb", public_key: "ssh-ed25519 AAAA test" },
            ],
          },
        },
      });

      // Must authenticate first
      mockFetch({
        "/servers": { status: 200, body: { servers: [] } },
        "/ssh_keys": {
          status: 200,
          body: {
            ssh_keys: [
              { id: 42, name: "spawn-key", fingerprint: "aa:bb", public_key: "ssh-ed25519 AAAA test" },
            ],
          },
        },
      });
      await provider.authenticate({ token: "tok" });

      const keyId = await provider.ensureSSHKey("spawn-key", "ssh-ed25519 AAAA test");
      expect(keyId).toBe("42");
    });

    it("registers new key if not found", async () => {
      mockFetch({
        "/servers": { status: 200, body: { servers: [] } },
      });
      await provider.authenticate({ token: "tok" });

      mockFetch({
        "/ssh_keys": {
          status: 200,
          body: { ssh_keys: [] },
        },
      });

      // Override fetch to handle both GET and POST
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        fetchCalls.push({ url: urlStr, init: init ?? {} });

        if (urlStr.includes("/ssh_keys") && init?.method === "GET") {
          return new Response(JSON.stringify({ ssh_keys: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/ssh_keys") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ ssh_key: { id: 99, name: "new-key", fingerprint: "cc:dd", public_key: "ssh-ed25519 BBBB" } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };

      const keyId = await provider.ensureSSHKey("new-key", "ssh-ed25519 BBBB");
      expect(keyId).toBe("99");
    });
  });

  describe("provision", () => {
    it("creates a server and returns ServerInfo", async () => {
      // Authenticate first
      mockFetch({
        "/servers": { status: 200, body: { servers: [] } },
      });
      await provider.authenticate({ token: "tok" });

      // Now mock provision calls
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        fetchCalls.push({ url: urlStr, init: init ?? {} });

        if (urlStr.includes("/ssh_keys")) {
          return new Response(
            JSON.stringify({ ssh_keys: [{ id: 1, name: "key", fingerprint: "aa", public_key: "ssh" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/servers") && init?.method === "POST") {
          const body = JSON.parse(init?.body as string);
          expect(body.name).toBe("test-server");
          expect(body.server_type).toBe("cpx11");
          expect(body.location).toBe("fsn1");
          expect(body.image).toBe("ubuntu-24.04");
          expect(body.ssh_keys).toEqual([1]);
          expect(body.start_after_create).toBe(true);

          return new Response(
            JSON.stringify({
              server: {
                id: 12345,
                name: "test-server",
                status: "initializing",
                public_net: { ipv4: { ip: "1.2.3.4" } },
                server_type: { name: "cpx11" },
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };

      const info = await provider.provision("test-server", { token: "tok" });
      expect(info.id).toBe("12345");
      expect(info.name).toBe("test-server");
      expect(info.ip).toBe("1.2.3.4");
      expect(info.user).toBe("root");
      expect(info.cloud).toBe("hetzner");
    });

    it("uses custom server type and region from config", async () => {
      mockFetch({ "/servers": { status: 200, body: { servers: [] } } });
      await provider.authenticate({ token: "tok" });

      let capturedBody: unknown;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(_url);
        if (urlStr.includes("/ssh_keys")) {
          return new Response(JSON.stringify({ ssh_keys: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (init?.method === "POST") {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(
            JSON.stringify({
              server: {
                id: 1,
                name: "s",
                status: "init",
                public_net: { ipv4: { ip: "5.6.7.8" } },
                server_type: { name: "cx22" },
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };

      await provider.provision("s", {
        token: "tok",
        serverType: "cx22",
        region: "nbg1",
        image: "ubuntu-22.04",
      });

      expect((capturedBody as Record<string, unknown>).server_type).toBe("cx22");
      expect((capturedBody as Record<string, unknown>).location).toBe("nbg1");
      expect((capturedBody as Record<string, unknown>).image).toBe("ubuntu-22.04");
    });
  });

  describe("destroy", () => {
    it("sends DELETE request to the API", async () => {
      mockFetch({ "/servers": { status: 200, body: { servers: [] } } });
      await provider.authenticate({ token: "tok" });

      mockFetch({
        "/servers/12345": { status: 200, body: {} },
      });

      const server = { id: "12345", name: "test", ip: "1.2.3.4", user: "root", cloud: "hetzner" };
      await provider.destroy(server);

      const deleteCall = fetchCalls.find(
        (c) => c.url.includes("/servers/12345") && c.init.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
    });

    it("throws descriptive error on API failure", async () => {
      mockFetch({ "/servers": { status: 200, body: { servers: [] } } });
      await provider.authenticate({ token: "tok" });

      mockFetch({
        "/servers/99": { status: 404, body: { error: { message: "not found" } } },
      });

      const server = { id: "99", name: "gone", ip: "0.0.0.0", user: "root", cloud: "hetzner" };
      await expect(provider.destroy(server)).rejects.toThrow(/Failed to destroy server 99/);
    });
  });
});
