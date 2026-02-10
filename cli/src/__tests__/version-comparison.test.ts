import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

/**
 * Tests for version comparison logic in update-check.ts.
 *
 * The `compareVersions` function determines whether to trigger auto-update.
 * Bugs here could cause:
 * - Missed updates (user stays on vulnerable/broken version)
 * - Update loops (same version triggers repeated updates)
 * - Downgrades (older version incorrectly treated as newer)
 *
 * Since compareVersions is not exported, we test it through checkForUpdates
 * by mocking fetch to return specific version strings and observing whether
 * the auto-update is triggered (via executor.execSync being called).
 *
 * Agent: test-engineer
 */

// ── Direct unit tests for version comparison logic ──────────────────────────
// Replica of the internal compareVersions function from update-check.ts
// to ensure the algorithm itself is correct for edge cases.

function compareVersions(current: string, latest: string): boolean {
  const parseSemver = (v: string): number[] =>
    v.split(".").map((n) => parseInt(n, 10) || 0);

  const currentParts = parseSemver(current);
  const latestParts = parseSemver(latest);

  for (let i = 0; i < 3; i++) {
    if ((latestParts[i] || 0) > (currentParts[i] || 0)) return true;
    if ((latestParts[i] || 0) < (currentParts[i] || 0)) return false;
  }

  return false; // Versions are equal
}

describe("compareVersions (unit)", () => {
  describe("equal versions", () => {
    it("should return false for identical versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(false);
    });

    it("should return false for identical multi-digit versions", () => {
      expect(compareVersions("10.20.30", "10.20.30")).toBe(false);
    });

    it("should return false for 0.0.0", () => {
      expect(compareVersions("0.0.0", "0.0.0")).toBe(false);
    });
  });

  describe("newer version available", () => {
    it("should detect major version bump", () => {
      expect(compareVersions("1.0.0", "2.0.0")).toBe(true);
    });

    it("should detect minor version bump", () => {
      expect(compareVersions("1.0.0", "1.1.0")).toBe(true);
    });

    it("should detect patch version bump", () => {
      expect(compareVersions("1.0.0", "1.0.1")).toBe(true);
    });

    it("should detect large patch bump", () => {
      expect(compareVersions("0.2.11", "0.2.12")).toBe(true);
    });

    it("should detect minor bump with higher patch on current", () => {
      expect(compareVersions("1.0.9", "1.1.0")).toBe(true);
    });

    it("should detect major bump regardless of minor/patch", () => {
      expect(compareVersions("1.9.9", "2.0.0")).toBe(true);
    });
  });

  describe("current version is newer (no update needed)", () => {
    it("should return false when current major is higher", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(false);
    });

    it("should return false when current minor is higher", () => {
      expect(compareVersions("1.2.0", "1.1.0")).toBe(false);
    });

    it("should return false when current patch is higher", () => {
      expect(compareVersions("1.0.2", "1.0.1")).toBe(false);
    });

    it("should return false when current has higher minor despite lower major", () => {
      expect(compareVersions("2.0.0", "1.9.9")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle versions with missing parts", () => {
      // parseSemver("1.0") produces [1, 0] — third part defaults to 0
      expect(compareVersions("1.0", "1.0.1")).toBe(true);
    });

    it("should handle single-segment versions", () => {
      expect(compareVersions("1", "2")).toBe(true);
      expect(compareVersions("2", "1")).toBe(false);
    });

    it("should handle versions with extra segments (ignores beyond 3)", () => {
      // compareVersions only looks at first 3 segments
      expect(compareVersions("1.0.0.1", "1.0.0.2")).toBe(false);
    });

    it("should handle non-numeric segments as 0", () => {
      // parseInt("beta", 10) returns NaN, || 0 makes it 0
      expect(compareVersions("1.0.beta", "1.0.1")).toBe(true);
    });

    it("should handle version 0.0.0 vs any", () => {
      expect(compareVersions("0.0.0", "0.0.1")).toBe(true);
      expect(compareVersions("0.0.0", "0.1.0")).toBe(true);
      expect(compareVersions("0.0.0", "1.0.0")).toBe(true);
    });

    it("should handle multi-digit version segments", () => {
      expect(compareVersions("0.2.11", "0.2.100")).toBe(true);
      expect(compareVersions("0.2.100", "0.2.11")).toBe(false);
    });

    it("should not treat version strings lexicographically", () => {
      // "9" > "10" lexicographically, but 9 < 10 numerically
      expect(compareVersions("0.0.9", "0.0.10")).toBe(true);
      expect(compareVersions("0.9.0", "0.10.0")).toBe(true);
    });
  });
});

// ── Integration tests through checkForUpdates ───────────────────────────────

describe("checkForUpdates version comparison integration", () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Ensure we are NOT in test environment for checkForUpdates
    process.env.NODE_ENV = undefined;
    process.env.BUN_ENV = undefined;
    process.env.SPAWN_NO_UPDATE_CHECK = undefined;

    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {}) as any);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
    global.fetch = originalFetch;
  });

  async function runCheckWithRemoteVersion(remoteVersion: string): Promise<{
    updateTriggered: boolean;
    exitCalled: boolean;
  }> {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: remoteVersion }),
      } as Response)
    );
    const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

    const { executor } = await import("../update-check.js");
    const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    const updateTriggered = execSyncSpy.mock.calls.length > 0;
    const exitCalled = processExitSpy.mock.calls.length > 0;

    fetchSpy.mockRestore();
    execSyncSpy.mockRestore();

    return { updateTriggered, exitCalled };
  }

  it("should trigger update for higher major version", async () => {
    const result = await runCheckWithRemoteVersion("99.0.0");
    expect(result.updateTriggered).toBe(true);
  });

  it("should trigger update for higher minor version", async () => {
    const result = await runCheckWithRemoteVersion("0.99.0");
    expect(result.updateTriggered).toBe(true);
  });

  it("should trigger update for higher patch version", async () => {
    const result = await runCheckWithRemoteVersion("0.2.999");
    expect(result.updateTriggered).toBe(true);
  });

  it("should NOT trigger update for same version as current", async () => {
    // Import the current version to use it
    const pkg = await import("../../package.json");
    const result = await runCheckWithRemoteVersion(pkg.default.version);
    expect(result.updateTriggered).toBe(false);
  });

  it("should NOT trigger update for lower version", async () => {
    const result = await runCheckWithRemoteVersion("0.0.1");
    expect(result.updateTriggered).toBe(false);
  });

  it("should handle fetch returning null version gracefully", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response)
    );
    const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

    const { executor } = await import("../update-check.js");
    const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    // Should not attempt update with undefined version
    expect(execSyncSpy.mock.calls.length).toBe(0);

    fetchSpy.mockRestore();
    execSyncSpy.mockRestore();
  });

  it("should handle fetch returning non-ok response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
      } as Response)
    );
    const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

    const { executor } = await import("../update-check.js");
    const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    expect(execSyncSpy.mock.calls.length).toBe(0);

    fetchSpy.mockRestore();
    execSyncSpy.mockRestore();
  });

  it("should handle fetch throwing error", async () => {
    const fetchSpy = spyOn(global, "fetch").mockImplementation(() =>
      Promise.reject(new Error("Network timeout"))
    );

    const { checkForUpdates } = await import("../update-check.js");
    // Should not throw
    await checkForUpdates();

    fetchSpy.mockRestore();
  });

  it("should continue with command when auto-update execSync fails", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: "99.0.0" }),
      } as Response)
    );
    const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

    const { executor } = await import("../update-check.js");
    const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {
      throw new Error("curl failed");
    });

    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    // Should have attempted update
    expect(execSyncSpy.mock.calls.length).toBeGreaterThan(0);
    // Should NOT have exited (continues with original command)
    expect(processExitSpy).not.toHaveBeenCalledWith(0);
    // Should have shown failure message
    const output = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Auto-update failed");

    fetchSpy.mockRestore();
    execSyncSpy.mockRestore();
  });

  it("should exit with code 0 after successful auto-update", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: "99.0.0" }),
      } as Response)
    );
    const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

    const { executor } = await import("../update-check.js");
    const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {
      // Simulate successful update
    });

    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    // Should exit with 0 after successful update
    expect(processExitSpy).toHaveBeenCalledWith(0);

    fetchSpy.mockRestore();
    execSyncSpy.mockRestore();
  });

  it("should show update banner with correct version numbers", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: "5.10.15" }),
      } as Response)
    );
    const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

    const { executor } = await import("../update-check.js");
    const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    const output = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("5.10.15");
    expect(output).toContain("Update available");

    fetchSpy.mockRestore();
    execSyncSpy.mockRestore();
  });

  it("should skip when SPAWN_NO_UPDATE_CHECK is set", async () => {
    process.env.SPAWN_NO_UPDATE_CHECK = "1";

    const fetchSpy = spyOn(global, "fetch");
    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("should skip in NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";

    const fetchSpy = spyOn(global, "fetch");
    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("should skip in BUN_ENV=test", async () => {
    process.env.BUN_ENV = "test";

    const fetchSpy = spyOn(global, "fetch");
    const { checkForUpdates } = await import("../update-check.js");
    await checkForUpdates();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
