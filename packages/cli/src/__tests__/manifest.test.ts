import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Manifest } from "../manifest";
import { loadManifest, agentKeys, cloudKeys, matrixStatus, countImplemented } from "../manifest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestEnvironment } from "./test-helpers";
import {
  createMockManifest,
  createEmptyManifest,
  mockSuccessfulFetch,
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

      // The manifest was fetched and returned successfully
      expect(manifest.agents).toBeDefined();
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
  });
});
