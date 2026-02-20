import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

/**
 * Tests for version comparison logic in update-check.ts.
 *
 * The compareVersions function is CRITICAL: it decides whether auto-update
 * runs. A bug here could either skip updates (stale CLI) or trigger spurious
 * updates (unnecessary restarts). The function is not exported, so we test
 * an exact replica and also verify behavior through the full checkForUpdates
 * flow with edge-case version strings.
 *
 * Agent: test-engineer
 */

// ── Exact replica of compareVersions from update-check.ts lines 33-47 ──────

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

// ── Exact replica of parseSemver from update-check.ts ────────────────────────

function parseSemver(v: string): number[] {
  return v.split(".").map((n) => parseInt(n, 10) || 0);
}

describe("Version Comparison Logic", () => {
  // ── Core comparisons ────────────────────────────────────────────────

  describe("compareVersions - basic comparisons", () => {
    it("should return true when latest major is higher", () => {
      expect(compareVersions("1.0.0", "2.0.0")).toBe(true);
    });

    it("should return true when latest minor is higher", () => {
      expect(compareVersions("1.0.0", "1.1.0")).toBe(true);
    });

    it("should return true when latest patch is higher", () => {
      expect(compareVersions("1.0.0", "1.0.1")).toBe(true);
    });

    it("should return false when versions are equal", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(false);
    });

    it("should return false when current is newer (major)", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(false);
    });

    it("should return false when current is newer (minor)", () => {
      expect(compareVersions("1.2.0", "1.1.0")).toBe(false);
    });

    it("should return false when current is newer (patch)", () => {
      expect(compareVersions("1.0.5", "1.0.3")).toBe(false);
    });
  });

  // ── Precedence: major > minor > patch ───────────────────────────────

  describe("compareVersions - precedence ordering", () => {
    it("should prefer major over minor", () => {
      // latest has higher major but lower minor
      expect(compareVersions("1.9.0", "2.0.0")).toBe(true);
    });

    it("should prefer major over patch", () => {
      expect(compareVersions("1.0.9", "2.0.0")).toBe(true);
    });

    it("should prefer minor over patch", () => {
      expect(compareVersions("1.0.9", "1.1.0")).toBe(true);
    });

    it("should not upgrade when current major is higher despite lower minor/patch", () => {
      expect(compareVersions("2.0.0", "1.9.9")).toBe(false);
    });

    it("should not upgrade when current minor is higher despite lower patch", () => {
      expect(compareVersions("1.5.0", "1.4.9")).toBe(false);
    });
  });

  // ── Edge cases: missing/extra segments ──────────────────────────────

  describe("compareVersions - segment edge cases", () => {
    it("should treat missing segments as 0 (two-segment current)", () => {
      // "1.0" parses to [1, 0], latestParts[2] defaults to 0
      expect(compareVersions("1.0", "1.0.1")).toBe(true);
    });

    it("should treat missing segments as 0 (two-segment latest)", () => {
      expect(compareVersions("1.0.1", "1.0")).toBe(false);
    });

    it("should handle single-segment versions", () => {
      expect(compareVersions("1", "2")).toBe(true);
      expect(compareVersions("2", "1")).toBe(false);
    });

    it("should consider 1.0.0 and 1.0 as equal", () => {
      expect(compareVersions("1.0.0", "1.0")).toBe(false);
      expect(compareVersions("1.0", "1.0.0")).toBe(false);
    });

    it("should ignore extra segments beyond the third", () => {
      // Only first 3 segments matter (loop runs i < 3)
      expect(compareVersions("1.0.0.0", "1.0.0.1")).toBe(false);
      expect(compareVersions("1.0.0", "1.0.0.99")).toBe(false);
    });
  });

  // ── Edge cases: zero versions ──────────────────────────────────────

  describe("compareVersions - zero and boundary versions", () => {
    it("should handle 0.0.0 to 0.0.1", () => {
      expect(compareVersions("0.0.0", "0.0.1")).toBe(true);
    });

    it("should handle 0.0.0 to 0.0.0", () => {
      expect(compareVersions("0.0.0", "0.0.0")).toBe(false);
    });

    it("should handle 0.0.0 to 1.0.0", () => {
      expect(compareVersions("0.0.0", "1.0.0")).toBe(true);
    });

    it("should handle large version numbers", () => {
      expect(compareVersions("99.99.99", "100.0.0")).toBe(true);
    });

    it("should handle very large patch numbers", () => {
      expect(compareVersions("1.0.999", "1.0.1000")).toBe(true);
    });
  });

  // ── Edge cases: non-numeric segments ───────────────────────────────

  describe("compareVersions - non-numeric input handling", () => {
    it("should treat non-numeric segments as 0 via parseInt fallback", () => {
      // parseInt("abc", 10) returns NaN, || 0 makes it 0
      expect(compareVersions("1.0.0", "1.0.abc")).toBe(false);
    });

    it("should parse leading digits from mixed strings", () => {
      // parseInt("3beta", 10) returns 3
      expect(compareVersions("1.0.2", "1.0.3beta")).toBe(true);
    });

    it("should treat empty string segments as 0", () => {
      // "1..0" splits to ["1", "", "0"], parseInt("") = NaN, || 0 = 0
      expect(compareVersions("1.0.0", "1..0")).toBe(false);
    });

    it("should handle version strings with v prefix parsed as 0", () => {
      // "v1" → parseInt("v1") = NaN → 0
      // This tests that the function doesn't strip prefixes
      expect(compareVersions("v1.0.0", "v2.0.0")).toBe(false);
      // Both parse to [0, 0, 0] and [0, 0, 0] because "v1" → NaN → 0
    });
  });

  // ── parseSemver helper ─────────────────────────────────────────────

  describe("parseSemver", () => {
    it("should parse standard semver", () => {
      expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    });

    it("should parse two-segment version", () => {
      expect(parseSemver("1.2")).toEqual([1, 2]);
    });

    it("should parse single-segment version", () => {
      expect(parseSemver("5")).toEqual([5]);
    });

    it("should convert NaN to 0", () => {
      expect(parseSemver("abc.def.ghi")).toEqual([0, 0, 0]);
    });

    it("should parse leading digits from mixed strings", () => {
      expect(parseSemver("3beta.1rc.2alpha")).toEqual([3, 1, 2]);
    });

    it("should handle empty segments as 0", () => {
      expect(parseSemver("1..3")).toEqual([1, 0, 3]);
    });

    it("should handle large numbers", () => {
      expect(parseSemver("100.200.300")).toEqual([100, 200, 300]);
    });
  });

  // ── Integration: compareVersions with realistic spawn versions ─────

  describe("compareVersions - realistic spawn version scenarios", () => {
    it("should detect upgrade from 0.2.3 to 0.2.4 (patch bump)", () => {
      expect(compareVersions("0.2.3", "0.2.4")).toBe(true);
    });

    it("should detect upgrade from 0.2.3 to 0.3.0 (minor bump)", () => {
      expect(compareVersions("0.2.3", "0.3.0")).toBe(true);
    });

    it("should detect upgrade from 0.2.3 to 1.0.0 (major bump)", () => {
      expect(compareVersions("0.2.3", "1.0.0")).toBe(true);
    });

    it("should not downgrade from 0.3.0 to 0.2.9", () => {
      expect(compareVersions("0.3.0", "0.2.9")).toBe(false);
    });

    it("should not upgrade when on same version 0.2.8", () => {
      expect(compareVersions("0.2.8", "0.2.8")).toBe(false);
    });

    it("should handle sequential patch bumps correctly", () => {
      // Simulate a chain of updates
      const versions = ["0.2.0", "0.2.1", "0.2.2", "0.2.3", "0.2.4"];
      for (let i = 0; i < versions.length - 1; i++) {
        expect(compareVersions(versions[i], versions[i + 1])).toBe(true);
        expect(compareVersions(versions[i + 1], versions[i])).toBe(false);
      }
    });
  });

  // ── Full flow: checkForUpdates with edge-case versions ─────────────

  describe("checkForUpdates integration with version edge cases", () => {
    let originalEnv: NodeJS.ProcessEnv;
    let consoleErrorSpy: ReturnType<typeof spyOn>;
    let processExitSpy: ReturnType<typeof spyOn>;
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      originalEnv = { ...process.env };
      // Clear test-skip env vars so checkForUpdates actually runs
      delete process.env.NODE_ENV;
      delete process.env.BUN_ENV;
      delete process.env.SPAWN_NO_UPDATE_CHECK;

      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      processExitSpy = spyOn(process, "exit").mockImplementation((() => {}) as any);
    });

    afterEach(() => {
      process.env = originalEnv;
      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
      if (fetchSpy) fetchSpy.mockRestore();
    });

    it("should not auto-update when remote returns same version", async () => {
      const pkg = await import("../../package.json");
      fetchSpy = spyOn(global, "fetch").mockImplementation(
        mock(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: pkg.default.version }),
          } as Response)
        )
      );

      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      execSyncSpy.mockRestore();
    });

    it("should not auto-update when remote returns older version", async () => {
      fetchSpy = spyOn(global, "fetch").mockImplementation(
        mock(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: "0.0.1" }),
          } as Response)
        )
      );

      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      execSyncSpy.mockRestore();
    });

    it("should auto-update when remote returns much higher version", async () => {
      fetchSpy = spyOn(global, "fetch").mockImplementation(
        mock(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: "99.0.0" }),
          } as Response)
        )
      );

      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(execSyncSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);

      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });

    it("should handle fetch returning null version gracefully", async () => {
      fetchSpy = spyOn(global, "fetch").mockImplementation(
        mock(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: null }),
          } as Response)
        )
      );

      const { checkForUpdates } = await import("../update-check.js");
      // Should not crash even with null version
      await checkForUpdates();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should skip update check when SPAWN_NO_UPDATE_CHECK=1", async () => {
      process.env.SPAWN_NO_UPDATE_CHECK = "1";
      fetchSpy = spyOn(global, "fetch");

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should skip update check when NODE_ENV=test", async () => {
      process.env.NODE_ENV = "test";
      fetchSpy = spyOn(global, "fetch");

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should skip update check when BUN_ENV=test", async () => {
      process.env.BUN_ENV = "test";
      fetchSpy = spyOn(global, "fetch");

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
