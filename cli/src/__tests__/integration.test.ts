import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Manifest } from "../manifest";
import {
  mockSuccessfulFetch,
  mockFailedFetch,
  setupTestEnvironment,
  teardownTestEnvironment,
  type TestEnvironment,
} from "./test-helpers";

describe("CLI Integration Tests", () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  const mockManifest: Manifest = {
    agents: {
      testAgent: {
        name: "Test Agent",
        description: "Test agent for integration",
        url: "https://test.com",
        install: "echo 'install'",
        launch: "echo 'launch'",
        env: {
          TEST_KEY: "test-value",
        },
      },
    },
    clouds: {
      testCloud: {
        name: "Test Cloud",
        description: "Test cloud provider",
        url: "https://test-cloud.com",
        type: "vm",
        auth: "token",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: {
      "testCloud/testAgent": "implemented",
    },
  };

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-integration-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env.XDG_CACHE_HOME = testDir;
  });

  afterEach(() => {
    process.env = originalEnv;

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should handle version command", async () => {
    // This test verifies the basic CLI structure works
    // In a real environment, we'd spawn the CLI process
    // For now, we just verify the version module exports

    const { VERSION } = await import("../version");
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should cache manifest after first load", async () => {
    const cacheDir = join(testDir, "spawn");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, "manifest.json");

    // Mock fetch for manifest load
    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: async () => mockManifest,
    }) as any);

    // Dynamically import to use the mocked environment
    const { loadManifest } = await import("../manifest");

    // First load - should fetch and cache
    const manifest1 = await loadManifest(true);
    expect(manifest1).toEqual(mockManifest);

    // Verify cache file was created
    expect(existsSync(cacheFile)).toBe(true);
    const cachedData = JSON.parse(readFileSync(cacheFile, "utf-8"));
    expect(cachedData).toEqual(mockManifest);

    // Second load - should use cache
    mock.restore();
    const manifest2 = await loadManifest();

    // Note: Bun's in-memory caching may behave differently
    expect(manifest2).toEqual(mockManifest);
  });

  it("should handle offline scenario with stale cache", async () => {
    const cacheDir = join(testDir, "spawn");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, "manifest.json");

    // Write stale cache (2 hours old)
    writeFileSync(cacheFile, JSON.stringify(mockManifest));
    const oldTime = Date.now() - 2 * 60 * 60 * 1000;
    const { utimesSync } = await import("fs");
    utimesSync(cacheFile, new Date(oldTime), new Date(oldTime));

    // Mock network failure
    global.fetch = mock(() => Promise.reject(new Error("Network unavailable")));

    const { loadManifest } = await import("../manifest");

    // Should fall back to stale cache
    const manifest = await loadManifest();
    expect(manifest).toEqual(mockManifest);
  });

  it("should properly format agent and cloud keys", async () => {
    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: async () => mockManifest,
    }) as any);

    const { loadManifest, agentKeys, cloudKeys } = await import("../manifest");

    const manifest = await loadManifest(true);
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    expect(agents).toEqual(["testAgent"]);
    expect(clouds).toEqual(["testCloud"]);
  });

  it("should validate matrix entries correctly", async () => {
    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: async () => mockManifest,
    }) as any);

    const { loadManifest, matrixStatus } = await import("../manifest");

    const manifest = await loadManifest(true);

    expect(matrixStatus(manifest, "testCloud", "testAgent")).toBe("implemented");
    expect(matrixStatus(manifest, "nonexistent", "testAgent")).toBe("missing");
    expect(matrixStatus(manifest, "testCloud", "nonexistent")).toBe("missing");
  });

  it("should count implemented combinations", async () => {
    const multiManifest: Manifest = {
      agents: {
        agent1: mockManifest.agents.testAgent,
        agent2: { ...mockManifest.agents.testAgent, name: "Agent 2" },
      },
      clouds: {
        cloud1: mockManifest.clouds.testCloud,
        cloud2: { ...mockManifest.clouds.testCloud, name: "Cloud 2" },
      },
      matrix: {
        "cloud1/agent1": "implemented",
        "cloud1/agent2": "implemented",
        "cloud2/agent1": "implemented",
        "cloud2/agent2": "missing",
      },
    };

    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: async () => multiManifest,
    }) as any);

    const { loadManifest, countImplemented } = await import("../manifest");

    const manifest = await loadManifest(true);
    const count = countImplemented(manifest);

    expect(count).toBe(3);
  });
});
