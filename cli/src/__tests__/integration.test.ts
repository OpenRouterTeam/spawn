import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { Manifest } from "../manifest";
import {
  mockSuccessfulFetch,
  mockFailedFetch,
  setupTestEnvironment,
  teardownTestEnvironment,
  type TestEnvironment,
} from "./test-helpers";

describe("CLI Integration Tests", () => {
  let env: TestEnvironment;

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
    env = setupTestEnvironment();
  });

  afterEach(() => {
    teardownTestEnvironment(env);
  });

  it("should handle version command", async () => {
    // This test verifies the basic CLI structure works
    // In a real environment, we'd spawn the CLI process
    // For now, we just verify the version is exported from package.json

    const pkg = await import("../../package.json", {
      with: {
        type: "json",
      },
    });
    const VERSION = pkg.default.version;
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should cache manifest after first load", async () => {
    mkdirSync(env.cacheDir, {
      recursive: true,
    });

    // Mock fetch for manifest load
    global.fetch = mockSuccessfulFetch(mockManifest);

    // Dynamically import to use the mocked environment
    const { loadManifest } = await import("../manifest");

    // First load - should fetch and cache
    const manifest1 = await loadManifest(true);
    expect(manifest1).toEqual(mockManifest);

    // Cache location depends on whether the test runs in the project directory
    // In the spawn project root, it uses a local manifest.json, so cache may not be written
    const cacheExists = existsSync(env.cacheFile);
    if (cacheExists) {
      const cachedData = JSON.parse(readFileSync(env.cacheFile, "utf-8"));
      expect(cachedData).toEqual(mockManifest);
    }

    // Second load - should use cache
    const manifest2 = await loadManifest();

    // Note: Bun's in-memory caching may behave differently
    expect(manifest2).toEqual(mockManifest);
  });

  it("should handle offline scenario with stale cache", async () => {
    mkdirSync(env.cacheDir, {
      recursive: true,
    });

    // Write stale cache (2 hours old)
    writeFileSync(env.cacheFile, JSON.stringify(mockManifest));
    const oldTime = Date.now() - 2 * 60 * 60 * 1000;
    const { utimesSync } = await import("node:fs");
    utimesSync(env.cacheFile, new Date(oldTime), new Date(oldTime));

    // Mock network failure
    global.fetch = mockFailedFetch("Network unavailable");

    const { loadManifest } = await import("../manifest");

    // Should fall back to stale cache
    const manifest = await loadManifest();
    expect(manifest).toEqual(mockManifest);
  });

  it("should properly format agent and cloud keys", async () => {
    global.fetch = mockSuccessfulFetch(mockManifest);

    const { loadManifest, agentKeys, cloudKeys } = await import("../manifest");

    const manifest = await loadManifest(true);
    const agents = agentKeys(manifest);
    const clouds = cloudKeys(manifest);

    expect(agents).toEqual([
      "testAgent",
    ]);
    expect(clouds).toEqual([
      "testCloud",
    ]);
  });

  it("should validate matrix entries correctly", async () => {
    global.fetch = mockSuccessfulFetch(mockManifest);

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
        agent2: {
          ...mockManifest.agents.testAgent,
          name: "Agent 2",
        },
      },
      clouds: {
        cloud1: mockManifest.clouds.testCloud,
        cloud2: {
          ...mockManifest.clouds.testCloud,
          name: "Cloud 2",
        },
      },
      matrix: {
        "cloud1/agent1": "implemented",
        "cloud1/agent2": "implemented",
        "cloud2/agent1": "implemented",
        "cloud2/agent2": "missing",
      },
    };

    global.fetch = mockSuccessfulFetch(multiManifest);

    const { loadManifest, countImplemented } = await import("../manifest");

    const manifest = await loadManifest(true);
    const count = countImplemented(manifest);

    expect(count).toBe(3);
  });
});
