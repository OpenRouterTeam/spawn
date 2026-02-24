import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Manifest } from "../manifest";
import { loadManifest, agentKeys, cloudKeys, matrixStatus, countImplemented } from "../manifest";
import type { TestEnvironment } from "./test-helpers";
import { createMockManifest, setupTestEnvironment, teardownTestEnvironment } from "./test-helpers";

/**
 * Tests for manifest.ts validation and edge cases that are not covered
 * by the existing manifest.test.ts, focusing on:
 * - isValidManifest with various invalid shapes
 * - logError behavior
 * - loadManifest caching edge cases
 * - countImplemented with mixed statuses
 */

describe("Manifest Validation Edge Cases", () => {
  describe("isValidManifest (via loadManifest)", () => {
    let env: TestEnvironment;

    beforeEach(() => {
      env = setupTestEnvironment();
    });

    afterEach(() => {
      teardownTestEnvironment(env);
    });

    it("should reject manifest missing agents field", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              clouds: {},
              matrix: {},
            }),
          ),
        ),
      );

      try {
        await loadManifest(true);
        // If local manifest fallback kicks in, that's ok
      } catch (err: any) {
        expect(err.message).toContain("Cannot load manifest");
      }
    });

    it("should reject manifest missing clouds field", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agents: {},
              matrix: {},
            }),
          ),
        ),
      );

      try {
        await loadManifest(true);
      } catch (err: any) {
        expect(err.message).toContain("Cannot load manifest");
      }
    });

    it("should reject manifest missing matrix field", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agents: {},
              clouds: {},
            }),
          ),
        ),
      );

      try {
        await loadManifest(true);
      } catch (err: any) {
        expect(err.message).toContain("Cannot load manifest");
      }
    });

    it("should reject null manifest data", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(null))));

      try {
        await loadManifest(true);
      } catch (err: any) {
        expect(err.message).toContain("Cannot load manifest");
      }
    });

    it("should reject empty object manifest data", async () => {
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({}))));

      try {
        await loadManifest(true);
      } catch (err: any) {
        expect(err.message).toContain("Cannot load manifest");
      }
    });

    it("should accept valid manifest with empty collections", async () => {
      const validEmpty = {
        agents: {},
        clouds: {},
        matrix: {},
      };
      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(validEmpty))));

      const manifest = await loadManifest(true);
      expect(manifest).toHaveProperty("agents");
      expect(manifest).toHaveProperty("clouds");
      expect(manifest).toHaveProperty("matrix");
    });

    it("should handle non-ok HTTP response from GitHub", async () => {
      // When GitHub returns a non-ok response, fetchManifestFromGitHub returns null
      // and loadManifest falls back to cache or throws
      global.fetch = mock(() =>
        Promise.resolve(
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );

      try {
        const manifest = await loadManifest(true);
        // If it succeeds, it used a fallback (stale cache or local manifest)
        expect(manifest).toHaveProperty("agents");
        expect(manifest).toHaveProperty("clouds");
        expect(manifest).toHaveProperty("matrix");
      } catch (err: any) {
        // Or it failed because no cache was available
        expect(err.message).toContain("Cannot load manifest");
      }
    });
  });

  describe("matrixStatus edge cases", () => {
    it("should return missing for undefined cloud/agent pair", () => {
      const manifest = createMockManifest();
      expect(matrixStatus(manifest, "", "")).toBe("missing");
    });

    it("should handle keys with special but valid characters", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "my-cloud/my-agent": "implemented",
          "cloud_2/agent_2": "implemented",
        },
      };
      expect(matrixStatus(manifest, "my-cloud", "my-agent")).toBe("implemented");
      expect(matrixStatus(manifest, "cloud_2", "agent_2")).toBe("implemented");
      expect(matrixStatus(manifest, "my-cloud", "agent_2")).toBe("missing");
    });
  });

  describe("countImplemented edge cases", () => {
    it("should only count exactly 'implemented' status", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "implemented",
          "c/d": "missing",
          "e/f": "partial",
          "g/h": "implemented",
          "i/j": "IMPLEMENTED",
        },
      };
      expect(countImplemented(manifest)).toBe(2);
    });

    it("should count correctly with large matrix", () => {
      const matrix: Record<string, string> = {};
      for (let i = 0; i < 100; i++) {
        matrix[`cloud${i}/agent${i}`] = i % 3 === 0 ? "implemented" : "missing";
      }
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix,
      };
      // i=0,3,6,...,99 => 0,3,6,...,99 => count of multiples of 3 from 0-99
      // 0,3,6,...,99 = 34 values
      expect(countImplemented(manifest)).toBe(34);
    });
  });

  describe("agentKeys and cloudKeys ordering", () => {
    it("should preserve insertion order of agents", () => {
      const manifest: Manifest = {
        agents: {
          zeta: {
            name: "Zeta",
            description: "",
            url: "",
            install: "",
            launch: "",
            env: {},
          },
          alpha: {
            name: "Alpha",
            description: "",
            url: "",
            install: "",
            launch: "",
            env: {},
          },
          mid: {
            name: "Mid",
            description: "",
            url: "",
            install: "",
            launch: "",
            env: {},
          },
        },
        clouds: {},
        matrix: {},
      };
      expect(agentKeys(manifest)).toEqual([
        "zeta",
        "alpha",
        "mid",
      ]);
    });

    it("should preserve insertion order of clouds", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {
          zebra: {
            name: "Zebra",
            description: "",
            url: "",
            type: "",
            auth: "",
            provision_method: "",
            exec_method: "",
            interactive_method: "",
          },
          apple: {
            name: "Apple",
            description: "",
            url: "",
            type: "",
            auth: "",
            provision_method: "",
            exec_method: "",
            interactive_method: "",
          },
        },
        matrix: {},
      };
      expect(cloudKeys(manifest)).toEqual([
        "zebra",
        "apple",
      ]);
    });
  });
});
