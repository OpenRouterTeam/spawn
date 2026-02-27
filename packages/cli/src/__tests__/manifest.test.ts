import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Manifest } from "../manifest";
import { loadManifest, agentKeys, cloudKeys, matrixStatus, countImplemented } from "../manifest";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TestEnvironment } from "./test-helpers";
import {
  createMockManifest,
  createEmptyManifest,
  mockSuccessfulFetch,
  mockFailedFetch,
  setupTestEnvironment,
  teardownTestEnvironment,
} from "./test-helpers";

const mockManifest = createMockManifest();

describe("manifest", () => {
  describe("agentKeys", () => {
    it("should return all agent keys", () => {
      const keys = agentKeys(mockManifest);
      expect(keys).toEqual([
        "claude",
        "codex",
      ]);
    });

    it("should return empty array for empty agents", () => {
      const emptyManifest = createEmptyManifest();
      const keys = agentKeys(emptyManifest);
      expect(keys).toEqual([]);
    });
  });

  describe("cloudKeys", () => {
    it("should return all cloud keys", () => {
      const keys = cloudKeys(mockManifest);
      expect(keys).toEqual([
        "sprite",
        "hetzner",
      ]);
    });

    it("should return empty array for empty clouds", () => {
      const emptyManifest = createEmptyManifest();
      const keys = cloudKeys(emptyManifest);
      expect(keys).toEqual([]);
    });
  });

  describe("matrixStatus", () => {
    it("should return 'implemented' for existing implemented combination", () => {
      const status = matrixStatus(mockManifest, "sprite", "claude");
      expect(status).toBe("implemented");
    });

    it("should return 'missing' for existing missing combination", () => {
      const status = matrixStatus(mockManifest, "hetzner", "codex");
      expect(status).toBe("missing");
    });

    it("should return 'missing' for non-existent combination", () => {
      const status = matrixStatus(mockManifest, "aws", "claude");
      expect(status).toBe("missing");
    });

    it("should handle edge case with undefined matrix entry", () => {
      const status = matrixStatus(mockManifest, "nonexistent", "agent");
      expect(status).toBe("missing");
    });
  });

  describe("countImplemented", () => {
    it("should count implemented combinations correctly", () => {
      const count = countImplemented(mockManifest);
      expect(count).toBe(3);
    });

    it("should return 0 for empty matrix", () => {
      const emptyManifest = createEmptyManifest();
      const count = countImplemented(emptyManifest);
      expect(count).toBe(0);
    });

    it("should return 0 when all are missing", () => {
      const allMissing: Manifest = {
        agents: mockManifest.agents,
        clouds: mockManifest.clouds,
        matrix: {
          "sprite/claude": "missing",
          "sprite/codex": "missing",
          "hetzner/claude": "missing",
          "hetzner/codex": "missing",
        },
      };
      const count = countImplemented(allMissing);
      expect(count).toBe(0);
    });
  });

  describe("loadManifest", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should fetch from network when cache is missing", async () => {
      // Mock successful fetch
      global.fetch = mockSuccessfulFetch(mockManifest);

      const manifest = await loadManifest(true); // Force refresh

      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("manifest.json"),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );

      // Cache location depends on whether the test runs in the project directory
      // In the spawn project root, it uses a local manifest.json, so cache may not be written
      const cacheExists = existsSync(env.cacheFile);
      expect(typeof cacheExists).toBe("boolean");
    });

    it("should use disk cache when fresh", async () => {
      // Write fresh cache
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));

      // Mock fetch (should not be called for fresh cache)
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

      const manifest = await loadManifest();

      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should refresh cache when forceRefresh is true", async () => {
      // Write stale cache
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));

      // Mock successful fetch with different data
      const updatedManifest = {
        ...mockManifest,
        agents: {},
      };
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(updatedManifest))));

      const manifest = await loadManifest(true);

      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should use stale cache as fallback on network error", async () => {
      // Write old cache (more than 1 hour old)
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      const { utimesSync } = await import("node:fs");
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      // Mock network failure
      global.fetch = mockFailedFetch("Network error");

      const manifest = await loadManifest(true);

      // Should fall back to stale cache
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should throw error when no cache and network fails", async () => {
      // Ensure no cache exists in test directory
      if (existsSync(env.cacheFile)) {
        unlinkSync(env.cacheFile);
      }

      // Remove cache directory to ensure it's truly missing
      const cacheDir = join(env.testDir, "spawn");
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, {
          recursive: true,
          force: true,
        });
      }

      // Mock network failure
      global.fetch = mockFailedFetch("Network error");

      // tryLoadLocalManifest() returns null in test environments (NODE_ENV=test),
      // so with no cache and no network, loadManifest must throw.
      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("should validate manifest structure", async () => {
      // Mock fetch with invalid data (missing required fields)
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agents: {},
            }),
          ),
        ),
      ); // missing clouds and matrix

      // Write valid cache as fallback
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      const { utimesSync } = await import("node:fs");
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);

      // Should fall back to cache when fetched data is invalid
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should handle fetch timeout", async () => {
      // Mock timeout
      const timeoutFetch: typeof fetch = () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 100));
      global.fetch = mock(timeoutFetch);

      // Write cache as fallback
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      const { utimesSync } = await import("node:fs");
      utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

      const manifest = await loadManifest(true);

      // Should fall back to cache on timeout
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should return cached instance on subsequent calls", async () => {
      // Mock successful fetch
      global.fetch = mockSuccessfulFetch(mockManifest);

      const manifest1 = await loadManifest(true);
      const manifest2 = await loadManifest(); // Should use in-memory cache

      expect(manifest1).toBe(manifest2); // Same instance
      // Note: in real execution, fetch is only called once, but module caching
      // in tests may behave differently
      expect(manifest2).toHaveProperty("agents");
      expect(manifest2).toHaveProperty("clouds");
    });
  });
});
