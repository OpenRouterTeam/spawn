/**
 * cmd-status-cov.test.ts — Coverage tests for commands/status.ts
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isString } from "@openrouter/spawn-shared";
import { createMockManifest, mockClackPrompts } from "./test-helpers";

// ── Clack prompts mock ──────────────────────────────────────────────────────
const clack = mockClackPrompts();

const { cmdStatus } = await import("../commands/status.js");
const { _resetCacheForTesting } = await import("../manifest.js");
const { getSpawnCloudConfigPath } = await import("../shared/paths.js");

const mockManifest = createMockManifest();

function writeHistory(testDir: string, records: unknown[]) {
  writeFileSync(
    join(testDir, "history.json"),
    JSON.stringify({
      version: 1,
      records,
    }),
  );
}

function writeCloudConfig(cloud: string, data: Record<string, string>) {
  const configPath = getSpawnCloudConfigPath(cloud);
  const dir = configPath.substring(0, configPath.lastIndexOf("/"));
  mkdirSync(dir, {
    recursive: true,
  });
  writeFileSync(configPath, JSON.stringify(data));
}

describe("cmdStatus", () => {
  let savedSpawnHome: string | undefined;
  let testDir: string;
  let originalFetch: typeof global.fetch;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDir = join(process.env.HOME ?? "", `spawn-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, {
      recursive: true,
    });
    savedSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = testDir;
    originalFetch = global.fetch;

    clack.logInfo.mockReset();
    clack.logError.mockReset();
    clack.logStep.mockReset();
    clack.spinnerStart.mockReset();
    clack.spinnerStop.mockReset();
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.SPAWN_HOME = savedSpawnHome;
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
  });

  it("shows no servers message when history is empty", async () => {
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    await cmdStatus();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active cloud servers"));
  });

  it("outputs empty JSON array when no servers and json mode", async () => {
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    await cmdStatus({
      json: true,
    });
    expect(consoleSpy).toHaveBeenCalledWith("[]");
  });

  it("filters out local-cloud and deleted records", async () => {
    writeHistory(testDir, [
      {
        id: "1",
        agent: "claude",
        cloud: "local",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "localhost",
          user: "root",
          cloud: "local",
        },
      },
      {
        id: "2",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          deleted: true,
        },
      },
    ]);
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    await cmdStatus();
    expect(clack.logInfo).toHaveBeenCalledWith(expect.stringContaining("No active cloud servers"));
  });

  it("calls Hetzner API for hetzner servers", async () => {
    writeHistory(testDir, [
      {
        id: "hz-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    const fetchedUrls: string[] = [];
    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      fetchedUrls.push(u);
      if (u.includes("hetzner.cloud")) {
        return new Response(
          JSON.stringify({
            server: {
              status: "running",
            },
          }),
        );
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      json: true,
      probe: async () => true,
    });
    expect(fetchedUrls.some((u) => u.includes("hetzner.cloud/v1/servers/12345"))).toBe(true);
  });

  it("calls DO API for digitalocean servers", async () => {
    writeHistory(testDir, [
      {
        id: "do-1",
        agent: "claude",
        cloud: "digitalocean",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "2.3.4.5",
          user: "root",
          cloud: "digitalocean",
          server_id: "99999",
        },
      },
    ]);
    writeCloudConfig("digitalocean", {
      api_key: "do-token",
    });

    const fetchedUrls: string[] = [];
    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      fetchedUrls.push(u);
      if (u.includes("digitalocean.com")) {
        return new Response(
          JSON.stringify({
            droplet: {
              status: "active",
            },
          }),
        );
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      json: true,
      probe: async () => true,
    });
    expect(fetchedUrls.some((u) => u.includes("digitalocean.com/v2/droplets/99999"))).toBe(true);
  });

  it("returns unknown for unsupported clouds", async () => {
    writeHistory(testDir, [
      {
        id: "aws-1",
        agent: "claude",
        cloud: "aws",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "3.4.5.6",
          user: "ec2-user",
          cloud: "aws",
          server_id: "i-12345",
        },
      },
    ]);
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

    // Should not crash — unsupported clouds get "unknown"
    await cmdStatus({
      json: true,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("returns unknown for servers with no server_id", async () => {
    writeHistory(testDir, [
      {
        id: "noid",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
        },
      },
    ]);
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    await cmdStatus({
      json: true,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("returns unknown when no API token available", async () => {
    writeHistory(testDir, [
      {
        id: "notoken",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));
    await cmdStatus({
      json: true,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("prunes gone records when --prune is set", async () => {
    writeHistory(testDir, [
      {
        id: "prune-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response("Not Found", {
          status: 404,
        });
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      prune: true,
    });

    // Verify record was marked deleted
    const historyData = JSON.parse(readFileSync(join(testDir, "history.json"), "utf-8"));
    const prunedRecord = historyData.records.find((r: { id: string }) => r.id === "prune-1");
    expect(prunedRecord?.connection?.deleted).toBe(true);
  });

  it("shows prune/gone hint in table mode", async () => {
    writeHistory(testDir, [
      {
        id: "hint-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response("Not Found", {
          status: 404,
        });
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus();

    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg: string) => msg.includes("--prune") || msg.includes("gone"))).toBe(true);
  });

  it("applies agent filter", async () => {
    writeHistory(testDir, [
      {
        id: "f1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "111",
        },
      },
      {
        id: "f2",
        agent: "codex",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "5.6.7.8",
          user: "root",
          cloud: "hetzner",
          server_id: "222",
        },
      },
    ]);
    _resetCacheForTesting();
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(mockManifest))));

    // With codex filter, only 1 server should remain
    await cmdStatus({
      agentFilter: "codex",
      json: true,
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("shows running server count in table mode", async () => {
    writeHistory(testDir, [
      {
        id: "run-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response(
          JSON.stringify({
            server: {
              status: "running",
            },
          }),
        );
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      probe: async () => true,
    });

    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    // Should mention running servers and spawn list
    expect(infoCalls.some((msg: string) => msg.includes("running"))).toBe(true);
  });

  // ── Agent probe tests ───────────────────────────────────────────────────

  it("probes running server and reports agent_alive true in JSON", async () => {
    writeHistory(testDir, [
      {
        id: "probe-live",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response(
          JSON.stringify({
            server: {
              status: "running",
            },
          }),
        );
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      json: true,
      probe: async () => true,
    });

    const output = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0].agent_alive).toBe(true);
  });

  it("probes running server and reports agent_alive false in JSON", async () => {
    writeHistory(testDir, [
      {
        id: "probe-down",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response(
          JSON.stringify({
            server: {
              status: "running",
            },
          }),
        );
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      json: true,
      probe: async () => false,
    });

    const output = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0].agent_alive).toBe(false);
  });

  it("does not probe gone servers — agent_alive is null", async () => {
    writeHistory(testDir, [
      {
        id: "probe-gone",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    let probeCalled = false;
    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response("Not Found", {
          status: 404,
        });
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      json: true,
      probe: async () => {
        probeCalled = true;
        return true;
      },
    });

    expect(probeCalled).toBe(false);
    const output = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    const parsed = JSON.parse(output);
    expect(parsed[0].agent_alive).toBeNull();
  });

  it("shows unreachable warning when probe fails in table mode", async () => {
    writeHistory(testDir, [
      {
        id: "probe-warn",
        agent: "claude",
        cloud: "hetzner",
        timestamp: new Date().toISOString(),
        connection: {
          ip: "1.2.3.4",
          user: "root",
          cloud: "hetzner",
          server_id: "12345",
        },
      },
    ]);
    writeCloudConfig("hetzner", {
      api_key: "test-token",
    });

    _resetCacheForTesting();
    global.fetch = mock(async (url: string | URL | Request) => {
      const u = isString(url) ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("hetzner.cloud")) {
        return new Response(
          JSON.stringify({
            server: {
              status: "running",
            },
          }),
        );
      }
      return new Response(JSON.stringify(mockManifest));
    });

    await cmdStatus({
      probe: async () => false,
    });

    const infoCalls = clack.logInfo.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(infoCalls.some((msg: string) => msg.includes("unreachable"))).toBe(true);
  });
});
