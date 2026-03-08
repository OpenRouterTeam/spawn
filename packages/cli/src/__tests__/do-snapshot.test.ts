/**
 * do-snapshot.test.ts — Tests for findSpawnSnapshot().
 *
 * Verifies snapshot lookup: happy path, empty results, API errors,
 * invalid IDs, name filtering, and network failures.
 */

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

// ── Mock oauth (prevent interactive prompts) ──────────────────────────────

mock.module("../shared/oauth", () => ({
  getOrPromptApiKey: mock(() => Promise.resolve("sk-test")),
  getModelIdInteractive: mock(() => Promise.resolve("openrouter/auto")),
}));

// ── Import under test ─────────────────────────────────────────────────────

const { findSpawnSnapshot } = await import("../digitalocean/digitalocean");

describe("findSpawnSnapshot", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the latest snapshot ID sorted by created_at", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            images: [
              {
                id: 100,
                name: "spawn-claude-20260101-0000",
                created_at: "2026-01-01T00:00:00Z",
              },
              {
                id: 200,
                name: "spawn-claude-20260301-0000",
                created_at: "2026-03-01T00:00:00Z",
              },
              {
                id: 150,
                name: "spawn-claude-20260201-0000",
                created_at: "2026-02-01T00:00:00Z",
              },
            ],
          }),
        ),
      ),
    );

    const result = await findSpawnSnapshot("claude");
    expect(result).toBe("200");
  });

  it("filters by name prefix — ignores other agents", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            images: [
              {
                id: 300,
                name: "spawn-codex-20260301-0000",
                created_at: "2026-03-01T00:00:00Z",
              },
              {
                id: 400,
                name: "spawn-claude-20260201-0000",
                created_at: "2026-02-01T00:00:00Z",
              },
            ],
          }),
        ),
      ),
    );

    const result = await findSpawnSnapshot("claude");
    expect(result).toBe("400");
  });

  it("returns null when no images are found", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            images: [],
          }),
        ),
      ),
    );

    const result = await findSpawnSnapshot("claude");
    expect(result).toBeNull();
  });

  it("returns null when no images match the agent name", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            images: [
              {
                id: 100,
                name: "spawn-codex-20260101-0000",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        ),
      ),
    );

    const result = await findSpawnSnapshot("claude");
    expect(result).toBeNull();
  });

  it("returns null on API error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", {
          status: 401,
        }),
      ),
    );

    const result = await findSpawnSnapshot("claude");
    expect(result).toBeNull();
  });

  it("returns null when snapshot ID is invalid (non-numeric)", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            images: [
              {
                id: "not-a-number",
                name: "spawn-claude-20260101-0000",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        ),
      ),
    );

    const result = await findSpawnSnapshot("claude");
    expect(result).toBeNull();
  });

  it("returns null on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network unreachable")));

    const result = await findSpawnSnapshot("claude");
    expect(result).toBeNull();
  });
});
