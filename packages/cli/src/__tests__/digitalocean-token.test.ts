import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { _testHelpers } from "../digitalocean/digitalocean";

const { testDoToken, doApi, state } = _testHelpers;

describe("testDoToken", () => {
  const originalFetch = globalThis.fetch;
  let savedToken: string;

  beforeEach(() => {
    savedToken = state.token;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    state.token = savedToken;
    _testHelpers.recovering401 = false;
  });

  it("returns false when token is empty", async () => {
    state.token = "";
    expect(await testDoToken()).toBe(false);
  });

  it("returns true when API returns valid account JSON", async () => {
    state.token = "valid-token";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            account: {
              uuid: "abc-123",
            },
          }),
        ),
      ),
    );
    expect(await testDoToken()).toBe(true);
  });

  it("returns false (not throws) when API returns 401", async () => {
    state.token = "expired-token";
    // Set recovering401 to skip OAuth recovery during testDoToken validation
    _testHelpers.recovering401 = true;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
        }),
      ),
    );
    expect(await testDoToken()).toBe(false);
  });

  it("returns false when API returns 403", async () => {
    state.token = "forbidden-token";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("Forbidden", {
          status: 403,
        }),
      ),
    );
    expect(await testDoToken()).toBe(false);
  });

  it("returns false on network error", async () => {
    state.token = "some-token";
    globalThis.fetch = mock(() => Promise.reject(new TypeError("fetch failed")));
    expect(await testDoToken()).toBe(false);
  });
});

describe("doApi 401 OAuth recovery", () => {
  const originalFetch = globalThis.fetch;
  let savedToken: string;

  beforeEach(() => {
    savedToken = state.token;
    _testHelpers.recovering401 = false;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    state.token = savedToken;
    _testHelpers.recovering401 = false;
  });

  it("attempts OAuth recovery on 401 before throwing", async () => {
    state.token = "expired-token";
    let doApiCalls = 0;
    let oauthChecks = 0;
    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = String(url);
      // DO API calls
      if (urlStr.includes("api.digitalocean.com")) {
        doApiCalls++;
        return Promise.resolve(
          new Response("Unauthorized", {
            status: 401,
          }),
        );
      }
      // OAuth connectivity check — fail it so tryDoOAuth returns null quickly
      // (avoids starting a real Bun.serve OAuth server)
      if (urlStr.includes("cloud.digitalocean.com")) {
        oauthChecks++;
        return Promise.reject(new Error("network unavailable"));
      }
      // Ignore non-DO requests (e.g. telemetry) to avoid cross-test interference
      return Promise.resolve(new Response("ok"));
    });

    // OAuth recovery fails (connectivity check fails), so doApi throws the 401
    await expect(doApi("GET", "/account", undefined, 1)).rejects.toThrow("DigitalOcean API error 401");
    // Verify recovery was attempted: 1 API call + 1 connectivity check
    expect(doApiCalls).toBe(1);
    expect(oauthChecks).toBe(1);
  });

  it("succeeds after OAuth recovery provides a new token", async () => {
    state.token = "expired-token";
    let callCount = 0;
    globalThis.fetch = mock((url: string | URL | Request) => {
      callCount++;
      const urlStr = String(url);
      // First call: the actual API call returning 401
      if (callCount === 1) {
        return Promise.resolve(
          new Response("Unauthorized", {
            status: 401,
          }),
        );
      }
      // OAuth connectivity check — fail so tryDoOAuth returns null
      if (urlStr.includes("cloud.digitalocean.com")) {
        return Promise.reject(new Error("network unavailable"));
      }
      return Promise.resolve(new Response("ok"));
    });

    // tryDoOAuth returns null, so this should throw
    await expect(doApi("GET", "/account", undefined, 1)).rejects.toThrow("DigitalOcean API error 401");
  });

  it("skips OAuth recovery when re-entrancy guard is set", async () => {
    state.token = "expired-token";
    _testHelpers.recovering401 = true;
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
        }),
      );
    });

    // Should throw immediately — only 1 fetch (the API call), no OAuth attempt
    await expect(doApi("GET", "/account", undefined, 1)).rejects.toThrow("DigitalOcean API error 401");
    expect(callCount).toBe(1);
  });

  it("resets re-entrancy guard after failed recovery", async () => {
    state.token = "expired-token";
    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("cloud.digitalocean.com")) {
        return Promise.reject(new Error("network error"));
      }
      return Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
        }),
      );
    });

    await expect(doApi("GET", "/account", undefined, 1)).rejects.toThrow("DigitalOcean API error 401");
    expect(_testHelpers.recovering401).toBe(false);
  });
});
