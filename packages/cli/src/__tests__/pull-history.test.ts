import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPullHistory, parseAndMergeChildHistory } from "../commands/pull-history.js";
import * as historyModule from "../history.js";
import { loadHistory } from "../history.js";

// ─── parseAndMergeChildHistory tests ─────────────────────────────────────────

describe("parseAndMergeChildHistory", () => {
  let origSpawnHome: string | undefined;

  beforeEach(() => {
    origSpawnHome = process.env.SPAWN_HOME;
    // Use isolated temp dir for history (preload sets HOME to a temp dir)
    const tmpHome = process.env.HOME ?? "/tmp";
    const spawnDir = join(tmpHome, `.spawn-test-${Date.now()}-${Math.random()}`);
    mkdirSync(spawnDir, {
      recursive: true,
    });
    process.env.SPAWN_HOME = spawnDir;
    // Write empty history
    writeFileSync(
      join(spawnDir, "history.json"),
      JSON.stringify({
        version: 1,
        records: [],
      }),
    );
  });

  afterEach(() => {
    if (origSpawnHome === undefined) {
      delete process.env.SPAWN_HOME;
    } else {
      process.env.SPAWN_HOME = origSpawnHome;
    }
  });

  it("returns 0 for empty string", () => {
    expect(parseAndMergeChildHistory("", "parent-123")).toBe(0);
  });

  it("returns 0 for empty object", () => {
    expect(parseAndMergeChildHistory("{}", "parent-123")).toBe(0);
  });

  it("returns 0 for invalid JSON", () => {
    expect(parseAndMergeChildHistory("not json", "parent-123")).toBe(0);
  });

  it("returns 0 for empty records array", () => {
    const json = JSON.stringify({
      version: 1,
      records: [],
    });
    expect(parseAndMergeChildHistory(json, "parent-123")).toBe(0);
  });

  it("parses and merges valid child records", () => {
    const json = JSON.stringify({
      version: 1,
      records: [
        {
          id: "child-1",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-03-26T00:00:00Z",
        },
        {
          id: "child-2",
          agent: "codex",
          cloud: "digitalocean",
          timestamp: "2026-03-26T00:01:00Z",
          name: "test-spawn",
        },
      ],
    });

    const count = parseAndMergeChildHistory(json, "parent-123");
    expect(count).toBe(2);

    // Verify records were merged into history
    const history = loadHistory();
    const child1 = history.find((r) => r.id === "child-1");
    const child2 = history.find((r) => r.id === "child-2");
    expect(child1).toBeDefined();
    expect(child1!.agent).toBe("claude");
    expect(child1!.parent_id).toBe("parent-123");
    expect(child2).toBeDefined();
    expect(child2!.name).toBe("test-spawn");
    expect(child2!.parent_id).toBe("parent-123");
  });

  it("preserves existing parent_id from child records", () => {
    const json = JSON.stringify({
      version: 1,
      records: [
        {
          id: "grandchild-1",
          agent: "claude",
          cloud: "aws",
          timestamp: "2026-03-26T00:00:00Z",
          parent_id: "child-abc",
          depth: 2,
        },
      ],
    });

    const count = parseAndMergeChildHistory(json, "parent-123");
    expect(count).toBe(1);

    const history = loadHistory();
    const gc = history.find((r) => r.id === "grandchild-1");
    expect(gc).toBeDefined();
    // parent_id should be preserved from the child record, not overwritten
    // (mergeChildHistory only sets parent_id if it's not already set)
    expect(gc!.parent_id).toBe("child-abc");
    expect(gc!.depth).toBe(2);
  });

  it("skips records without an id", () => {
    const json = JSON.stringify({
      version: 1,
      records: [
        {
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-03-26T00:00:00Z",
        },
        {
          id: "valid-1",
          agent: "codex",
          cloud: "gcp",
          timestamp: "2026-03-26T00:01:00Z",
        },
      ],
    });

    const count = parseAndMergeChildHistory(json, "parent-123");
    expect(count).toBe(1);
  });

  it("preserves connection info from child records", () => {
    const json = JSON.stringify({
      version: 1,
      records: [
        {
          id: "child-conn",
          agent: "claude",
          cloud: "digitalocean",
          timestamp: "2026-03-26T00:00:00Z",
          connection: {
            ip: "10.0.0.1",
            user: "root",
            server_id: "12345",
          },
        },
      ],
    });

    const count = parseAndMergeChildHistory(json, "parent-123");
    expect(count).toBe(1);

    const history = loadHistory();
    const child = history.find((r) => r.id === "child-conn");
    expect(child!.connection?.ip).toBe("10.0.0.1");
    expect(child!.connection?.server_id).toBe("12345");
  });

  it("deduplicates — calling twice with same records only merges once", () => {
    const json = JSON.stringify({
      version: 1,
      records: [
        {
          id: "dedup-1",
          agent: "claude",
          cloud: "hetzner",
          timestamp: "2026-03-26T00:00:00Z",
        },
      ],
    });

    parseAndMergeChildHistory(json, "parent-123");
    parseAndMergeChildHistory(json, "parent-123");

    const history = loadHistory();
    const matches = history.filter((r) => r.id === "dedup-1");
    expect(matches.length).toBe(1);
  });

  it("handles whitespace-only input", () => {
    expect(parseAndMergeChildHistory("   \n  ", "parent-123")).toBe(0);
  });

  it("handles history without version field", () => {
    const json = JSON.stringify({
      records: [
        {
          id: "no-version",
          agent: "hermes",
          cloud: "sprite",
          timestamp: "2026-03-26T00:00:00Z",
        },
      ],
    });

    const count = parseAndMergeChildHistory(json, "parent-123");
    expect(count).toBe(1);
  });
});

// ─── cmdPullHistory tests ───────────────────────────────────────────────────

describe("cmdPullHistory", () => {
  it("returns immediately when no active servers", async () => {
    const spy = spyOn(historyModule, "getActiveServers").mockReturnValue([]);
    await cmdPullHistory();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("skips servers without connection info", async () => {
    const activeSpy = spyOn(historyModule, "getActiveServers").mockReturnValue([
      {
        id: "test-1",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-26T00:00:00Z",
      },
    ]);
    const spawnSpy = spyOn(Bun, "spawn");
    await cmdPullHistory();
    // No SSH connection should have been attempted for a record with no connection info
    expect(spawnSpy).not.toHaveBeenCalled();
    activeSpy.mockRestore();
    spawnSpy.mockRestore();
  });

  it("skips servers with missing ip", async () => {
    const activeSpy = spyOn(historyModule, "getActiveServers").mockReturnValue([
      {
        id: "test-2",
        agent: "claude",
        cloud: "hetzner",
        timestamp: "2026-03-26T00:00:00Z",
        connection: {
          ip: "",
          user: "root",
        },
      },
    ]);
    const spawnSpy = spyOn(Bun, "spawn");
    await cmdPullHistory();
    // No SSH connection should have been attempted for a record with empty IP
    expect(spawnSpy).not.toHaveBeenCalled();
    activeSpy.mockRestore();
    spawnSpy.mockRestore();
  });
});
