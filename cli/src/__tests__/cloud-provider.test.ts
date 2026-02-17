import { describe, it, expect } from "bun:test";
import {
  cloudAPI,
  CloudAPIError,
  type CloudProvider,
  type CloudProviderConfig,
  type ServerInfo,
} from "../cloud-provider.js";

describe("CloudProvider interface", () => {
  it("defines all required methods", () => {
    // Type-level test: ensure the interface is structurally sound
    // by creating a mock that satisfies it
    const mock: CloudProvider = {
      label: "Test Cloud",
      id: "test",
      authenticate: async (_config: CloudProviderConfig) => {},
      ensureSSHKey: async (_name: string, _publicKey: string) => "key-1",
      provision: async (name: string, _config: CloudProviderConfig): Promise<ServerInfo> => ({
        id: "srv-1",
        name,
        ip: "1.2.3.4",
        user: "root",
        cloud: "test",
      }),
      waitReady: async () => {},
      run: async () => "output",
      upload: async () => {},
      interactive: async () => {},
      destroy: async () => {},
    };

    expect(mock.label).toBe("Test Cloud");
    expect(mock.id).toBe("test");
    expect(typeof mock.authenticate).toBe("function");
    expect(typeof mock.ensureSSHKey).toBe("function");
    expect(typeof mock.provision).toBe("function");
    expect(typeof mock.waitReady).toBe("function");
    expect(typeof mock.run).toBe("function");
    expect(typeof mock.upload).toBe("function");
    expect(typeof mock.interactive).toBe("function");
    expect(typeof mock.destroy).toBe("function");
  });

  it("ServerInfo has required fields", () => {
    const info: ServerInfo = {
      id: "srv-123",
      name: "my-server",
      ip: "10.0.0.1",
      user: "root",
      cloud: "hetzner",
    };

    expect(info.id).toBe("srv-123");
    expect(info.name).toBe("my-server");
    expect(info.ip).toBe("10.0.0.1");
    expect(info.user).toBe("root");
    expect(info.cloud).toBe("hetzner");
  });

  it("CloudProviderConfig has required and optional fields", () => {
    const minimal: CloudProviderConfig = { token: "test-token" };
    expect(minimal.token).toBe("test-token");
    expect(minimal.serverType).toBeUndefined();
    expect(minimal.region).toBeUndefined();

    const full: CloudProviderConfig = {
      token: "test-token",
      serverType: "cpx11",
      region: "fsn1",
      image: "ubuntu-24.04",
      sshPublicKey: "ssh-ed25519 AAAA...",
    };
    expect(full.serverType).toBe("cpx11");
    expect(full.region).toBe("fsn1");
    expect(full.image).toBe("ubuntu-24.04");
  });
});

describe("CloudAPIError", () => {
  it("captures status and body", () => {
    const err = new CloudAPIError(404, { error: "not found" }, "GET /servers/123 failed with 404");
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: "not found" });
    expect(err.message).toBe("GET /servers/123 failed with 404");
    expect(err.name).toBe("CloudAPIError");
    expect(err instanceof Error).toBe(true);
  });
});

describe("cloudAPI", () => {
  it("constructs correct URL from base and endpoint", async () => {
    // Mock fetch globally
    const originalFetch = globalThis.fetch;
    let capturedURL = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedURL = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ servers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await cloudAPI("https://api.example.com/v1", "test-token", "GET", "/servers");
      expect(capturedURL).toBe("https://api.example.com/v1/servers");
      expect(capturedInit?.method).toBe("GET");
      expect((capturedInit?.headers as Record<string, string>)?.["Authorization"]).toBe("Bearer test-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends JSON body for POST requests", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody = "";

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ server: { id: 1 } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await cloudAPI("https://api.example.com", "tok", "POST", "/servers", {
        name: "test",
        type: "cpx11",
      });
      const parsed = JSON.parse(capturedBody);
      expect(parsed.name).toBe("test");
      expect(parsed.type).toBe("cpx11");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws CloudAPIError on non-2xx responses", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await expect(cloudAPI("https://api.example.com", "bad-token", "GET", "/servers")).rejects.toThrow(CloudAPIError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns parsed JSON data on success", async () => {
    const originalFetch = globalThis.fetch;
    const mockData = { servers: [{ id: 1, name: "test" }] };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await cloudAPI<typeof mockData>("https://api.example.com", "tok", "GET", "/servers");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data.servers).toHaveLength(1);
      expect(result.data.servers[0].name).toBe("test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send body for GET requests", async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await cloudAPI("https://api.example.com", "tok", "GET", "/servers", { ignored: true });
      expect(capturedInit?.body).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
