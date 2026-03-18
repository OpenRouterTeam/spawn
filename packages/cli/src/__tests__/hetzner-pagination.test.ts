import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isString } from "@openrouter/spawn-shared";

const FAKE_TOKEN = "test-hetzner-token-pagination";

function makeServersPage(ids: number[], nextPage: number | null) {
  return {
    servers: ids.map((id) => ({
      id,
      name: `server-${id}`,
      status: "running",
      public_net: {
        ipv4: {
          ip: `1.2.3.${id}`,
        },
      },
    })),
    meta: {
      pagination: {
        page: nextPage ? nextPage - 1 : 1,
        per_page: 50,
        previous_page: null,
        next_page: nextPage,
        last_page: nextPage ?? 1,
        total_entries: ids.length,
      },
    },
  };
}

function makeSshKeysPage(ids: number[], nextPage: number | null) {
  return {
    ssh_keys: ids.map((id) => ({
      id,
      name: `key-${id}`,
      fingerprint: `aa:bb:cc:${id}`,
    })),
    meta: {
      pagination: {
        page: nextPage ? nextPage - 1 : 1,
        per_page: 50,
        previous_page: null,
        next_page: nextPage,
        last_page: nextPage ?? 1,
        total_entries: ids.length,
      },
    },
  };
}

describe("Hetzner API pagination", () => {
  const savedToken = process.env.HCLOUD_TOKEN;
  const savedFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.HCLOUD_TOKEN = FAKE_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedToken !== undefined) {
      process.env.HCLOUD_TOKEN = savedToken;
    } else {
      delete process.env.HCLOUD_TOKEN;
    }
  });

  it("listServers fetches all pages of servers", async () => {
    const page1Ids = Array.from(
      {
        length: 50,
      },
      (_, i) => i + 1,
    );
    const page2Ids = Array.from(
      {
        length: 10,
      },
      (_, i) => i + 51,
    );

    globalThis.fetch = mock((url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.href : url.url;

      // testHcloudToken calls /servers?per_page=1
      if (u.includes("/servers?per_page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      // Paginated server listing
      if (u.includes("/servers") && u.includes("page=1")) {
        return Promise.resolve(new Response(JSON.stringify(makeServersPage(page1Ids, 2))));
      }
      if (u.includes("/servers") && u.includes("page=2")) {
        return Promise.resolve(new Response(JSON.stringify(makeServersPage(page2Ids, null))));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    // Fresh import to pick up mocked fetch and env
    const mod = await import("../hetzner/hetzner");
    await mod.ensureHcloudToken();
    const servers = await mod.listServers();

    expect(servers).toHaveLength(60);
    expect(servers[0].id).toBe("1");
    expect(servers[0].ip).toBe("1.2.3.1");
    expect(servers[59].id).toBe("60");
    expect(servers[59].ip).toBe("1.2.3.60");
  });

  it("listServers handles single page", async () => {
    const ids = [
      1,
      2,
      3,
    ];

    globalThis.fetch = mock((url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.href : url.url;

      if (u.includes("/servers?per_page=1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              servers: [],
            }),
          ),
        );
      }
      if (u.includes("/servers")) {
        return Promise.resolve(new Response(JSON.stringify(makeServersPage(ids, null))));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    const mod = await import("../hetzner/hetzner");
    await mod.ensureHcloudToken();
    const servers = await mod.listServers();

    expect(servers).toHaveLength(3);
  });
});
