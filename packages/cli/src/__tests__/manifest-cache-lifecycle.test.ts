import type { Manifest } from "../manifest";
import type { TestEnvironment } from "./test-helpers";

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentKeys, countImplemented, loadManifest } from "../manifest";
import { createMockManifest, setupTestEnvironment, teardownTestEnvironment } from "./test-helpers";

/**
 * Tests for manifest.ts edge cases not covered by manifest.test.ts.
 *
 * manifest.test.ts covers the core happy paths (fresh cache, stale fallback,
 * network error, validation). These tests cover:
 *
 * - Cache corruption recovery (corrupted JSON, wrong types in cache)
 * - fetchManifestFromGitHub with HTTP 403, 404, 500 and json() failures
 * - countImplemented case sensitivity
 * - In-memory cache forceRefresh bypass
 * - Fallback chain: invalid fetch data + stale cache
 */

const mockManifest = createMockManifest();

describe("Manifest Cache Lifecycle", () => {
  describe("cache file corruption recovery", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should recover from corrupted JSON in cache file", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, "{ invalid json content !!!");

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should recover from empty cache file", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, "");

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
    });

    it("should recover from cache containing a JSON array", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, "[1, 2, 3]");

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
    });

    it("should recover from cache containing a JSON string", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, '"just a string"');

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
    });

    it("should recover from cache containing partial manifest JSON", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      // Valid JSON but missing required fields
      writeFileSync(
        env.cacheFile,
        JSON.stringify({
          agents: {},
        }),
      );

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
    });
  });

  describe("fetchManifestFromGitHub HTTP error handling", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should fall back to stale cache on HTTP 500", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );

      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
    });

    it("should fall back to stale cache on HTTP 403 (rate limited)", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response("Forbidden", {
            status: 403,
            statusText: "Forbidden",
          }),
        ),
      );

      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
    });

    it("should fall back to stale cache when fetch response json() throws", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response("not valid json {{{", {
            status: 200,
          }),
        ),
      );

      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
    });

    it("should fall back to stale cache on TypeError (network down)", async () => {
      global.fetch = mock(() => Promise.reject(new TypeError("Failed to fetch")));

      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
    });

    it("should fall back when fetch returns invalid manifest structure", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agents: {
                claude: {},
              },
            }),
          ),
        ),
      ); // missing clouds and matrix

      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should throw when fetch fails with no cache at all", async () => {
      const cacheDir = join(env.testDir, "spawn");
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, {
          recursive: true,
          force: true,
        });
      }

      global.fetch = mock(() => Promise.reject(new Error("DNS resolution failed")));

      // tryLoadLocalManifest() returns null in test environments (NODE_ENV=test),
      // so with no cache and no network, loadManifest must throw.
      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });
  });

  describe("in-memory cache behavior", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should bypass in-memory cache with forceRefresh", async () => {
      const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
      global.fetch = fetchMock;

      await loadManifest(true);
      await loadManifest(true);

      // fetch should have been called at least twice (once per forceRefresh)
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should return same instance without forceRefresh", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest1 = await loadManifest(true);
      const manifest2 = await loadManifest(false);

      expect(manifest1).toBe(manifest2);
    });
  });

  describe("combined fallback chain: invalid fetch + stale cache", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should fall back to stale cache when fetch returns non-manifest data", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: 1,
              data: "not a manifest",
            }),
          ),
        ),
      );

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
      expect(agentKeys(manifest)).toContain("claude");
    });

    it("should return cached instance without calling fetch again", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));

      const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
      global.fetch = fetchMock;

      // loadManifest(true) populates in-memory cache, calls fetch once
      const m1 = await loadManifest(true);
      const callsAfterFirstLoad = fetchMock.mock.calls.length;

      // loadManifest(false) returns in-memory cache without fetching again
      const m2 = await loadManifest(false);
      expect(m2).toBe(m1);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirstLoad);
    });
  });

  describe("countImplemented edge cases", () => {
    it("should only count exact 'implemented' string (case-sensitive)", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "implemented",
          "c/d": "Implemented",
          "e/f": "IMPLEMENTED",
          "g/h": "missing",
          "i/j": "partial",
          "k/l": "implemented",
        },
      };
      expect(countImplemented(manifest)).toBe(2);
    });
  });
});
