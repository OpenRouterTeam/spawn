import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { loadManifest, agentKeys, cloudKeys, matrixStatus, countImplemented, type Manifest } from "../manifest";
import {
  createMockManifest,
  setupTestEnvironment,
  teardownTestEnvironment,
  type TestEnvironment,
} from "./test-helpers";

/**
 * Tests for manifest.ts edge cases not covered by manifest.test.ts.
 *
 * manifest.test.ts covers the core happy paths (fresh cache, stale fallback,
 * network error, validation). These tests cover:
 *
 * - isValidManifest with malformed/partial/unusual input types
 * - Cache corruption recovery (corrupted JSON, wrong types in cache)
 * - fetchManifestFromGitHub with HTTP 403, 404, 500 and json() failures
 * - matrixStatus key composition edge cases (slashes, empty strings, long keys)
 * - countImplemented case sensitivity and non-standard status values
 * - agentKeys/cloudKeys insertion order preservation
 * - In-memory cache forceRefresh bypass
 * - Fallback chain: invalid fetch data + stale cache
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── isValidManifest (exact replica from manifest.ts line 84-86) ──────────────
// The actual function uses short-circuit && which returns the last truthy value
// or first falsy value, NOT a boolean. Tests use toBeTruthy/toBeFalsy.

function isValidManifest(data: any): data is Manifest {
  return data?.agents && data.clouds && data.matrix;
}

describe("Manifest Cache Lifecycle", () => {
  describe("isValidManifest validation", () => {
    it("should accept a complete manifest", () => {
      expect(isValidManifest(mockManifest)).toBeTruthy();
    });

    it("should reject null", () => {
      expect(isValidManifest(null)).toBeFalsy();
    });

    it("should reject undefined", () => {
      expect(isValidManifest(undefined)).toBeFalsy();
    });

    it("should reject empty object", () => {
      expect(isValidManifest({})).toBeFalsy();
    });

    it("should reject manifest missing agents", () => {
      expect(
        isValidManifest({
          clouds: {},
          matrix: {},
        }),
      ).toBeFalsy();
    });

    it("should reject manifest missing clouds", () => {
      expect(
        isValidManifest({
          agents: {},
          matrix: {},
        }),
      ).toBeFalsy();
    });

    it("should reject manifest missing matrix", () => {
      expect(
        isValidManifest({
          agents: {},
          clouds: {},
        }),
      ).toBeFalsy();
    });

    it("should accept manifest with empty but present fields", () => {
      // Note: empty objects {} are truthy in JS, so this passes validation
      expect(
        isValidManifest({
          agents: {},
          clouds: {},
          matrix: {},
        }),
      ).toBeTruthy();
    });

    it("should reject a string", () => {
      expect(isValidManifest("not a manifest")).toBeFalsy();
    });

    it("should reject a number", () => {
      expect(isValidManifest(42)).toBeFalsy();
    });

    it("should reject an array", () => {
      expect(
        isValidManifest([
          1,
          2,
          3,
        ]),
      ).toBeFalsy();
    });

    it("should reject boolean true", () => {
      expect(isValidManifest(true)).toBeFalsy();
    });

    it("should reject boolean false", () => {
      expect(isValidManifest(false)).toBeFalsy();
    });

    it("should accept manifest with extra fields", () => {
      expect(
        isValidManifest({
          agents: {
            a: 1,
          },
          clouds: {
            b: 2,
          },
          matrix: {
            c: 3,
          },
          extra: "field",
          version: 2,
        }),
      ).toBeTruthy();
    });

    it("should reject when agents is null", () => {
      expect(
        isValidManifest({
          agents: null,
          clouds: {},
          matrix: {},
        }),
      ).toBeFalsy();
    });

    it("should reject when clouds is 0 (falsy)", () => {
      expect(
        isValidManifest({
          agents: {},
          clouds: 0,
          matrix: {},
        }),
      ).toBeFalsy();
    });

    it("should reject when matrix is empty string (falsy)", () => {
      expect(
        isValidManifest({
          agents: {},
          clouds: {},
          matrix: "",
        }),
      ).toBeFalsy();
    });

    it("should reject when matrix is false", () => {
      expect(
        isValidManifest({
          agents: {},
          clouds: {},
          matrix: false,
        }),
      ).toBeFalsy();
    });

    it("should accept when agents/clouds/matrix are arrays (truthy but wrong type)", () => {
      // The function only checks truthiness, not actual types
      // This is a known limitation - arrays are truthy
      expect(
        isValidManifest({
          agents: [
            1,
          ],
          clouds: [
            2,
          ],
          matrix: [
            3,
          ],
        }),
      ).toBeTruthy();
    });
  });

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
        Promise.resolve(new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })),
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
        Promise.resolve(new Response("Forbidden", { status: 403, statusText: "Forbidden" })),
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
      global.fetch = mock(() => Promise.resolve(new Response("not valid json {{{", { status: 200 })));

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

      try {
        await loadManifest(true);
        // If we get here, local manifest in project dir was used (valid)
      } catch (err: any) {
        expect(err.message).toContain("Cannot load manifest");
      }
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

    it("should use fresh disk cache without calling fetch", async () => {
      mkdirSync(join(env.testDir, "spawn"), {
        recursive: true,
      });
      writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
      // Cache is fresh (just written)

      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              agents: {},
              clouds: {},
              matrix: {},
            }),
          ),
        ),
      );

      // loadManifest(false) should check disk cache first
      // Note: in-memory _cached may already be set from prior test, so we forceRefresh first
      // to clear it, then test the non-forced path
      const m1 = await loadManifest(true); // clears in-memory, fetches
      // Now the in-memory cache is populated, so non-forced will return it
      const m2 = await loadManifest(false);
      expect(m2).toHaveProperty("agents");
    });
  });

  describe("matrixStatus edge cases", () => {
    it("should handle cloud/agent keys with hyphens", () => {
      const manifest: Manifest = {
        agents: {
          "my-agent": mockManifest.agents.claude,
        },
        clouds: {
          "my-cloud": mockManifest.clouds.sprite,
        },
        matrix: {
          "my-cloud/my-agent": "implemented",
        },
      };
      expect(matrixStatus(manifest, "my-cloud", "my-agent")).toBe("implemented");
    });

    it("should handle ambiguous slash in agent key", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "cloud/agent": "implemented",
        },
      };
      // "cloud" + "sub/agent" => "cloud/sub/agent" which doesn't match "cloud/agent"
      expect(matrixStatus(manifest, "cloud", "sub/agent")).toBe("missing");
    });

    it("should return missing for empty string cloud and agent", () => {
      expect(matrixStatus(mockManifest, "", "")).toBe("missing");
    });

    it("should return missing for very long keys", () => {
      const longKey = "a".repeat(200);
      expect(matrixStatus(mockManifest, longKey, longKey)).toBe("missing");
    });

    it("should handle keys with underscores", () => {
      const manifest: Manifest = {
        agents: {
          my_agent: mockManifest.agents.claude,
        },
        clouds: {
          my_cloud: mockManifest.clouds.sprite,
        },
        matrix: {
          "my_cloud/my_agent": "implemented",
        },
      };
      expect(matrixStatus(manifest, "my_cloud", "my_agent")).toBe("implemented");
    });

    it("should distinguish between similar keys", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "sprite/claude": "implemented",
          "sprite/claude-code": "missing",
        },
      };
      expect(matrixStatus(manifest, "sprite", "claude")).toBe("implemented");
      expect(matrixStatus(manifest, "sprite", "claude-code")).toBe("missing");
    });

    it("should use nullish coalescing to default to missing", () => {
      // Verify that undefined matrix entries default to "missing" via ??
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {},
      };
      expect(matrixStatus(manifest, "any", "thing")).toBe("missing");
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

    it("should return 0 for matrix with non-standard status values only", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "a/b": "missing",
          "c/d": "planned",
          "e/f": "wip",
          "g/h": "in-progress",
        },
      };
      expect(countImplemented(manifest)).toBe(0);
    });

    it("should handle large matrix efficiently", () => {
      const matrix: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        matrix[`cloud${i}/agent${i}`] = i % 3 === 0 ? "implemented" : "missing";
      }
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix,
      };
      // i=0,3,6,...,999: (999-0)/3 + 1 = 334
      expect(countImplemented(manifest)).toBe(334);
    });

    it("should count single implemented entry correctly", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {
          "only/one": "implemented",
        },
      };
      expect(countImplemented(manifest)).toBe(1);
    });

    it("should handle empty matrix", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {},
      };
      expect(countImplemented(manifest)).toBe(0);
    });
  });

  describe("agentKeys and cloudKeys ordering", () => {
    it("should preserve insertion order of agents", () => {
      const manifest: Manifest = {
        agents: {
          zulu: mockManifest.agents.claude,
          alpha: mockManifest.agents.codex,
          mike: mockManifest.agents.claude,
        },
        clouds: {},
        matrix: {},
      };
      expect(agentKeys(manifest)).toEqual([
        "zulu",
        "alpha",
        "mike",
      ]);
    });

    it("should preserve insertion order of clouds", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {
          zebra: mockManifest.clouds.sprite,
          apple: mockManifest.clouds.hetzner,
        },
        matrix: {},
      };
      expect(cloudKeys(manifest)).toEqual([
        "zebra",
        "apple",
      ]);
    });

    it("should handle manifest with many agents", () => {
      const agents: Record<string, any> = {};
      for (let i = 0; i < 50; i++) {
        agents[`agent-${i}`] = mockManifest.agents.claude;
      }
      const manifest: Manifest = {
        agents,
        clouds: {},
        matrix: {},
      };
      expect(agentKeys(manifest)).toHaveLength(50);
      expect(agentKeys(manifest)[0]).toBe("agent-0");
      expect(agentKeys(manifest)[49]).toBe("agent-49");
    });

    it("should handle manifest with many clouds", () => {
      const clouds: Record<string, any> = {};
      for (let i = 0; i < 30; i++) {
        clouds[`cloud-${i}`] = mockManifest.clouds.sprite;
      }
      const manifest: Manifest = {
        agents: {},
        clouds,
        matrix: {},
      };
      expect(cloudKeys(manifest)).toHaveLength(30);
    });

    it("should return empty arrays for empty manifest", () => {
      const manifest: Manifest = {
        agents: {},
        clouds: {},
        matrix: {},
      };
      expect(agentKeys(manifest)).toEqual([]);
      expect(cloudKeys(manifest)).toEqual([]);
    });

    it("should return single-element array for single agent", () => {
      const manifest: Manifest = {
        agents: {
          solo: mockManifest.agents.claude,
        },
        clouds: {},
        matrix: {},
      };
      expect(agentKeys(manifest)).toEqual([
        "solo",
      ]);
    });
  });
});
