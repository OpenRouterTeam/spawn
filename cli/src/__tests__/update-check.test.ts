import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

// ── Test Helpers ───────────────────────────────────────────────────────────────

function mockEnv() {
  const originalEnv = { ...process.env };
  process.env.NODE_ENV = undefined;
  process.env.BUN_ENV = undefined;
  process.env.SPAWN_NO_UPDATE_CHECK = undefined;
  return originalEnv;
}

function restoreEnv(originalEnv: NodeJS.ProcessEnv) {
  process.env = originalEnv;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("update-check", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalEnv = mockEnv();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    // Mock process.exit to prevent tests from exiting
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    restoreEnv(originalEnv);
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

    it("should check for updates on every run", async () => {
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
          json: () => Promise.resolve({ version: "0.2.3" }),
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

    it("should handle bad response format", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should not crash
      expect(processExitSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });
  });
});
