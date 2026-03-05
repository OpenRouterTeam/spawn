import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// We test findSpawnSnapshot by importing from the module.
// The function uses the module-level doToken + doApi, so we mock fetch.

const originalFetch = globalThis.fetch;

describe("findSpawnSnapshot", () => {
  // findSpawnSnapshot requires doToken to be set, which happens via ensureDoToken.
  // Since doToken is module-private, we test the function's behavior via fetch mocking.

  beforeEach(() => {
    // Reset fetch before each test
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns latest snapshot ID when API returns multiple images", async () => {
    const images = {
      images: [
        {
          id: 111,
          created_at: "2026-03-01T00:00:00Z",
          name: "spawn-claude-20260301",
        },
        {
          id: 222,
          created_at: "2026-03-03T00:00:00Z",
          name: "spawn-claude-20260303",
        },
        {
          id: 333,
          created_at: "2026-03-02T00:00:00Z",
          name: "spawn-claude-20260302",
        },
      ],
    };

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(images))));

    // Import fresh to avoid module-level state issues
    const { findSpawnSnapshot } = await import("../digitalocean/digitalocean");
    const result = await findSpawnSnapshot("claude");

    // Should return the latest (ID 222, created 2026-03-03)
    expect(result).toBe("222");
  });

  it("returns null when no images found", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            images: [],
          }),
        ),
      ),
    );

    const { findSpawnSnapshot } = await import("../digitalocean/digitalocean");
    const result = await findSpawnSnapshot("claude");

    expect(result).toBeNull();
  });

  it("returns null on API error (graceful fallback)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
        }),
      ),
    );

    const { findSpawnSnapshot } = await import("../digitalocean/digitalocean");
    const result = await findSpawnSnapshot("claude");

    expect(result).toBeNull();
  });

  it("returns null when images have no valid ID", async () => {
    const images = {
      images: [
        {
          id: "not-a-number",
          created_at: "2026-03-01T00:00:00Z",
        },
      ],
    };

    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(images))));

    const { findSpawnSnapshot } = await import("../digitalocean/digitalocean");
    const result = await findSpawnSnapshot("claude");

    expect(result).toBeNull();
  });

  it("returns null on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));

    const { findSpawnSnapshot } = await import("../digitalocean/digitalocean");
    const result = await findSpawnSnapshot("claude");

    expect(result).toBeNull();
  });
});
