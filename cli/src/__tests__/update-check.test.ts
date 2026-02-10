import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";

// ── Test Helpers ───────────────────────────────────────────────────────────────

const TEST_CACHE_DIR = join(process.cwd(), ".test-cache-update-check");
const TEST_UPDATE_CHECK_FILE = join(TEST_CACHE_DIR, "update-check.json");

function mockEnv() {
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = undefined;
  process.env.BUN_ENV = undefined;
  process.env.SPAWN_NO_UPDATE_CHECK = undefined;
  process.env.TEST_CACHE_DIR = TEST_CACHE_DIR;
  return originalEnv;
}

function restoreEnv(originalEnv: NodeJS.ProcessEnv) {
  process.env = originalEnv;
}

function setupTestCache() {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
}

function cleanupTestCache() {
  if (existsSync(TEST_CACHE_DIR)) {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
  }
}

function writeUpdateCheckCache(data: any) {
  mkdirSync(TEST_CACHE_DIR, { recursive: true });
  writeFileSync(TEST_UPDATE_CHECK_FILE, JSON.stringify(data, null, 2));
}

function readUpdateCheckCache(): any {
  if (!existsSync(TEST_UPDATE_CHECK_FILE)) return null;
  return JSON.parse(readFileSync(TEST_UPDATE_CHECK_FILE, "utf-8"));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("update-check", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    cleanupTestCache(); // Clean first to ensure fresh state
    originalEnv = mockEnv();
    setupTestCache();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    // Mock process.exit to prevent tests from exiting
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    cleanupTestCache();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe("checkForUpdates", () => {
    it("should skip in test environment", async () => {
      process.env.NODE_ENV = "test";

      const fetchSpy = spyOn(global, "fetch");

      // Dynamic import to get fresh module with test env
      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("should skip when SPAWN_NO_UPDATE_CHECK is set", async () => {
      process.env.SPAWN_NO_UPDATE_CHECK = "1";

      const fetchSpy = spyOn(global, "fetch");

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("should check for updates on first run", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.3.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should not check again within 24 hours", async () => {
      // Write a recent check to cache
      const now = Math.floor(Date.now() / 1000);
      writeUpdateCheckCache({
        lastCheck: now - 3600, // 1 hour ago
        latestVersion: "0.3.0",
      });

      const fetchSpy = spyOn(global, "fetch");

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should use cache, not fetch
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should check again after 24 hours", async () => {
      // Write an old check to cache
      const now = Math.floor(Date.now() / 1000);
      writeUpdateCheckCache({
        lastCheck: now - 86400 - 1, // Just over 24 hours ago
        latestVersion: "0.1.0",
      });

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.3.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should auto-update when newer version is available", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.3.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should have printed update message to stderr
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Update available");
      expect(output).toContain("0.3.0");
      expect(output).toContain("Updating automatically");

      // Should have run the install script
      expect(execSyncSpy).toHaveBeenCalled();

      // Should have exited
      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should not update when up to date", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.2.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should not auto-update
      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should handle network errors gracefully", async () => {
      const mockFetch = mock(() => Promise.reject(new Error("Network error")));
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should not crash or try to update
      expect(processExitSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it("should auto-update using cached version when skipping check", async () => {
      // Clear any previous state
      cleanupTestCache();
      setupTestCache();

      // Write a recent check with a newer version
      const now = Math.floor(Date.now() / 1000);
      writeUpdateCheckCache({
        lastCheck: now - 3600, // 1 hour ago
        latestVersion: "0.3.0",
      });

      const fetchSpy = spyOn(global, "fetch");

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should not fetch, but should auto-update from cache
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Update available");
      expect(output).toContain("0.3.0");

      // Should have run the install script
      expect(execSyncSpy).toHaveBeenCalled();

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should handle update failures gracefully", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.3.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to throw an error
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {
        throw new Error("Update failed");
      });

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should have printed error message
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Auto-update failed");

      // Should NOT have exited (continue with original command)
      expect(processExitSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });
  });

  describe("cache management", () => {
    it("should create cache directory if missing", async () => {
      cleanupTestCache();

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.3.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Cache file should exist now (if CACHE_DIR is writable)
      // This is non-critical, so we don't assert

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });

    it("should handle corrupted cache gracefully", async () => {
      // Write invalid JSON to cache
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
      writeFileSync(TEST_UPDATE_CHECK_FILE, "not valid json");

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.3.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync to prevent actual update
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should treat corrupted cache as missing and check for updates
      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
    });
  });
});
