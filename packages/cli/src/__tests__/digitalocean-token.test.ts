import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { _testHelpers } from "../digitalocean/digitalocean";

const { testDoToken, state } = _testHelpers;

describe("testDoToken", () => {
  const originalFetch = globalThis.fetch;
  let savedToken: string;

  beforeEach(() => {
    savedToken = state.token;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    state.token = savedToken;
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
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
        }),
      ),
    );
    // Before the fix, this would throw: "DigitalOcean API error 401..."
    // After the fix, asyncTryCatch catches the error and unwrapOr returns false
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
