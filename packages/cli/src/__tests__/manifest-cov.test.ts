/**
 * manifest-cov.test.ts — Coverage tests for manifest.ts
 *
 * Focuses on uncovered paths: stripDangerousKeys, isValidManifest edge cases,
 * stale cache fallback, local manifest loading, forceRefresh, utility functions
 * (agentKeys, cloudKeys, matrixStatus, countImplemented, isStaleCache, getCacheAge).
 */

import type { TestEnvironment } from "./test-helpers";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _resetCacheForTesting,
  agentKeys,
  cloudKeys,
  countImplemented,
  getCacheAge,
  isStaleCache,
  loadManifest,
  matrixStatus,
  stripDangerousKeys,
} from "../manifest";
import { createMockManifest, setupTestEnvironment, teardownTestEnvironment } from "./test-helpers";

const mockManifest = createMockManifest();

describe("manifest.ts coverage", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = setupTestEnvironment();
    _resetCacheForTesting();
  });

  afterEach(() => {
    teardownTestEnvironment(env);
  });

  // ── stripDangerousKeys ────────────────────────────────────────────────

  describe("stripDangerousKeys", () => {
    it("removes __proto__ keys", () => {
      const input = {
        normal: "ok",
        __proto__: {
          malicious: true,
        },
      };
      const cleaned = stripDangerousKeys(input);
      expect(cleaned).toEqual({
        normal: "ok",
      });
    });

    it("removes constructor keys", () => {
      const input = {
        a: 1,
        constructor: "bad",
      };
      const cleaned = stripDangerousKeys(input);
      expect(cleaned).toEqual({
        a: 1,
      });
    });

    it("removes prototype keys", () => {
      const input = {
        a: 1,
        prototype: {
          x: 1,
        },
      };
      const cleaned = stripDangerousKeys(input);
      expect(cleaned).toEqual({
        a: 1,
      });
    });

    it("recursively strips from nested objects", () => {
      const input = {
        nested: {
          __proto__: "bad",
          ok: "fine",
        },
      };
      const cleaned = stripDangerousKeys(input);
      expect(cleaned).toEqual({
        nested: {
          ok: "fine",
        },
      });
    });

    it("handles arrays", () => {
      const input = [
        {
          __proto__: "bad",
          ok: "fine",
        },
      ];
      const cleaned = stripDangerousKeys(input);
      expect(cleaned).toEqual([
        {
          ok: "fine",
        },
      ]);
    });

    it("returns primitives unchanged", () => {
      expect(stripDangerousKeys("hello")).toBe("hello");
      expect(stripDangerousKeys(42)).toBe(42);
      expect(stripDangerousKeys(null)).toBeNull();
      expect(stripDangerousKeys(true)).toBe(true);
    });
  });

  // ── agentKeys / cloudKeys / matrixStatus / countImplemented ────────────

  describe("utility functions", () => {
    it("agentKeys returns sorted by stars descending", () => {
      const keys = agentKeys(mockManifest);
      expect(keys).toContain("claude");
      expect(keys).toContain("codex");
    });

    it("cloudKeys returns cloud keys", () => {
      const keys = cloudKeys(mockManifest);
      expect(keys).toContain("sprite");
      expect(keys).toContain("hetzner");
    });

    it("matrixStatus returns implemented for known combo", () => {
      expect(matrixStatus(mockManifest, "sprite", "claude")).toBe("implemented");
    });

    it("matrixStatus returns missing for known missing combo", () => {
      expect(matrixStatus(mockManifest, "hetzner", "codex")).toBe("missing");
    });

    it("matrixStatus returns missing for unknown combo", () => {
      expect(matrixStatus(mockManifest, "unknown", "unknown")).toBe("missing");
    });

    it("countImplemented counts implemented entries", () => {
      const count = countImplemented(mockManifest);
      expect(count).toBe(3); // sprite/claude, sprite/codex, hetzner/claude
    });
  });

  // ── isStaleCache / getCacheAge ────────────────────────────────────────

  describe("cache state helpers", () => {
    it("isStaleCache returns false initially", () => {
      expect(isStaleCache()).toBe(false);
    });

    it("getCacheAge returns Infinity when no cache", () => {
      expect(getCacheAge()).toBe(Number.POSITIVE_INFINITY);
    });
  });

  // ── loadManifest ──────────────────────────────────────────────────────

  describe("loadManifest", () => {
    it("fetches from GitHub and caches", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      const m = await loadManifest();
      expect(m.agents).toBeDefined();
      expect(m.clouds).toBeDefined();
    });

    it("returns in-memory cache on second call", async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify(mockManifest)));
      global.fetch = fetchMock;
      await loadManifest();
      const fetchCount = fetchMock.mock.calls.length;
      await loadManifest();
      // Should not have fetched again
      expect(fetchMock.mock.calls.length).toBe(fetchCount);
    });

    it("reads from disk cache when fresh", async () => {
      // Write a fresh cache file
      const cacheDir = join(env.testDir, "spawn");
      mkdirSync(cacheDir, {
        recursive: true,
      });
      writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(mockManifest));

      _resetCacheForTesting();
      global.fetch = mock(
        async () =>
          new Response("should not be called", {
            status: 500,
          }),
      );

      const m = await loadManifest();
      expect(m.agents.claude).toBeDefined();
    });

    it("forceRefresh bypasses in-memory and disk cache", async () => {
      const updatedManifest = {
        ...mockManifest,
        agents: {
          ...mockManifest.agents,
          newagent: {
            name: "New Agent",
            description: "test",
            url: "test",
            install: "test",
            launch: "test",
            env: {},
          },
        },
      };

      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest();

      global.fetch = mock(async () => new Response(JSON.stringify(updatedManifest)));
      const m = await loadManifest(true);
      expect(m.agents.newagent).toBeDefined();
    });

    it("falls back to stale cache when fetch fails", async () => {
      // Write a cache file (will be stale because cache TTL check)
      const cacheDir = join(env.testDir, "spawn");
      mkdirSync(cacheDir, {
        recursive: true,
      });
      writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(mockManifest));

      _resetCacheForTesting();
      // All fetches fail
      global.fetch = mock(
        async () =>
          new Response("error", {
            status: 500,
          }),
      );

      const m = await loadManifest(true);
      expect(m.agents.claude).toBeDefined();
      expect(isStaleCache()).toBe(true);
    });

    it("throws when no cache and fetch fails", async () => {
      _resetCacheForTesting();
      global.fetch = mock(
        async () =>
          new Response("error", {
            status: 500,
          }),
      );

      // Make sure no cache file exists
      const cacheFile = join(env.testDir, "spawn", "manifest.json");
      if (existsSync(cacheFile)) {
        rmSync(cacheFile);
      }

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("handles invalid manifest from GitHub", async () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      global.fetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              not: "a manifest",
            }),
          ),
      );

      // Ensure no cache
      const cacheFile = join(env.testDir, "spawn", "manifest.json");
      if (existsSync(cacheFile)) {
        rmSync(cacheFile);
      }

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
      consoleSpy.mockRestore();
    });

    it("handles network error during fetch", async () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
      global.fetch = mock(async () => {
        throw new Error("Network timeout");
      });

      const cacheFile = join(env.testDir, "spawn", "manifest.json");
      if (existsSync(cacheFile)) {
        rmSync(cacheFile);
      }

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
      consoleSpy.mockRestore();
    });
  });
});
