import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Manifest } from "../manifest";
import { loadManifest, _resetCacheForTesting, agentKeys, cloudKeys, matrixStatus, countImplemented } from "../manifest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { TestEnvironment } from "./test-helpers";
import { setupTestEnvironment, teardownTestEnvironment } from "./test-helpers";

/**
 * Tests for manifest.ts internal helper behaviors that are not covered
 * by manifest.test.ts and manifest-validation.test.ts.
 *
 * Focus areas:
 * - isValidManifest with unexpected data shapes (arrays, strings, numbers)
 * - Cache write/read cycle edge cases
 * - Unusual matrixStatus key patterns
 * - countImplemented with various status strings
 *
 * Agent: test-engineer
 */

describe("Manifest Helper Edge Cases", () => {
  describe("isValidManifest with unusual data shapes", () => {
    let env: TestEnvironment;
    let savedNodeEnv: string | undefined;

    beforeEach(() => {
      env = setupTestEnvironment();
      _resetCacheForTesting();
      // Prevent local manifest.json fallback so fetch mock governs behavior
      savedNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
    });

    afterEach(() => {
      process.env.NODE_ENV = savedNodeEnv;
      teardownTestEnvironment(env);
    });

    it("should reject array as manifest data", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              1,
              2,
              3,
            ]),
          ),
        ),
      );

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("should reject string as manifest data", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify("not a manifest"))));

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("should reject number as manifest data", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(42))));

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("should reject boolean false as manifest data", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(false))));

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("should reject undefined as manifest data", async () => {
      global.fetch = mock(() => Promise.resolve(new Response("undefined")));

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });
  });

  describe("readCache with corrupted data", () => {
    let env: TestEnvironment;
    let savedNodeEnv: string | undefined;

    beforeEach(() => {
      env = setupTestEnvironment();
      _resetCacheForTesting();
      savedNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
    });

    afterEach(() => {
      process.env.NODE_ENV = savedNodeEnv;
      teardownTestEnvironment(env);
    });

    it("should handle corrupted JSON in cache file gracefully", async () => {
      mkdirSync(env.cacheDir, {
        recursive: true,
      });
      writeFileSync(env.cacheFile, "not valid json {{{");

      global.fetch = mock(() => Promise.reject(new Error("Network error")));

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });

    it("should handle empty cache file gracefully", async () => {
      mkdirSync(env.cacheDir, {
        recursive: true,
      });
      writeFileSync(env.cacheFile, "");

      global.fetch = mock(() => Promise.reject(new Error("Network error")));

      await expect(loadManifest(true)).rejects.toThrow("Cannot load manifest");
    });
  });

  describe("matrixStatus with unusual keys", () => {
    it("should handle keys with multiple slashes correctly", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "cloud/agent": "implemented",
        },
      };
      expect(matrixStatus(manifest, "cloud", "agent")).toBe("implemented");
      expect(matrixStatus(manifest, "clo", "ud/agent")).toBe("missing");
    });

    it("should handle empty string cloud and agent", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "/": "implemented",
        },
      };
      expect(matrixStatus(manifest, "", "")).toBe("implemented");
    });

    it("should handle hyphenated keys", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "cloud-eu/agent-v2": "implemented",
        },
      };
      expect(matrixStatus(manifest, "cloud-eu", "agent-v2")).toBe("implemented");
    });
  });

  describe("countImplemented with various status strings", () => {
    it("should not count 'Implemented' (capitalized)", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "Implemented",
        },
      };
      expect(countImplemented(manifest)).toBe(0);
    });

    it("should not count 'IMPLEMENTED'", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "IMPLEMENTED",
        },
      };
      expect(countImplemented(manifest)).toBe(0);
    });

    it("should not count 'implemented ' (with trailing space)", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "implemented ",
        },
      };
      expect(countImplemented(manifest)).toBe(0);
    });

    it("should not count empty string status", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "",
        },
      };
      expect(countImplemented(manifest)).toBe(0);
    });

    it("should handle manifest with only implemented entries", () => {
      const matrix: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        matrix[`cloud${i}/agent${i}`] = "implemented";
      }
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix,
      };
      expect(countImplemented(manifest)).toBe(50);
    });
  });

  describe("agentKeys and cloudKeys with many entries", () => {
    it("should return keys for manifest with many agents", () => {
      const agents: Record<string, Manifest["agents"][string]> = {};
      for (let i = 0; i < 20; i++) {
        agents[`agent-${i}`] = {
          name: `Agent ${i}`,
          description: "",
          url: "",
          install: "",
          launch: "",
          env: {},
        };
      }
      const manifest: Manifest = {
        agents,
        clouds: {},
        matrix: {},
      };
      expect(agentKeys(manifest)).toHaveLength(20);
    });

    it("should return keys for manifest with many clouds", () => {
      const clouds: Record<string, Manifest["clouds"][string]> = {};
      for (let i = 0; i < 20; i++) {
        clouds[`cloud-${i}`] = {
          name: `Cloud ${i}`,
          description: "",
          url: "",
          type: "",
          auth: "",
          provision_method: "",
          exec_method: "",
          interactive_method: "",
        };
      }
      const manifest: Manifest = {
        agents: {},
        clouds,
        matrix: {},
      };
      expect(cloudKeys(manifest)).toHaveLength(20);
    });
  });
});
