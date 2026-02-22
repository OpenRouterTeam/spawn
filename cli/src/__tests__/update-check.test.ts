import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// ── Test Helpers ───────────────────────────────────────────────────────────────

/** Remove the .update-failed backoff file so it doesn't interfere with tests */
function clearUpdateBackoff() {
  try {
    fs.unlinkSync(path.join(process.env.HOME || "/tmp", ".config", "spawn", ".update-failed"));
  } catch {
    // File may not exist
  }
}

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
    clearUpdateBackoff();
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
          json: () => Promise.resolve({ version: "99.0.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync and execFileSync to prevent actual update + re-exec
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });

    it("should auto-update when newer version is available", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "99.0.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execSync and execFileSync to prevent actual update + re-exec
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should have printed update message to stderr
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Update available");
      expect(output).toContain("99.0.0");
      expect(output).toContain("Updating automatically");

      // Should have run the install script + which spawn lookup
      expect(execSyncSpy).toHaveBeenCalled();

      // Should have exited
      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });

    it("should not update when up to date", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "0.2.3" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock executor to prevent actual commands
      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should not auto-update (no install script, no re-exec)
      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
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
          json: () => Promise.resolve({ version: "99.0.0" }),
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

    it("should re-exec with original args after successful update", async () => {
      const originalArgv = process.argv;
      process.argv = ["/usr/bin/bun", "/usr/local/bin/spawn", "claude", "sprite"];

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "99.0.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { executor } = await import("../update-check.js");
      const execSyncCalls: string[] = [];
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation((cmd: string) => {
        execSyncCalls.push(cmd);
      });
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // execSync called twice: install script + "which spawn" for binary lookup
      expect(execSyncCalls.length).toBe(2);
      expect(execSyncCalls[0]).toContain("install.sh");
      expect(execSyncCalls[1]).toContain("which spawn");

      // execFileSync called once for re-exec (no shell interpretation)
      expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
      expect(execFileSyncSpy.mock.calls[0][0]).toContain("spawn");
      expect(execFileSyncSpy.mock.calls[0][1]).toEqual(["claude", "sprite"]);

      // Should show rerunning message
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Rerunning");

      // Should set SPAWN_NO_UPDATE_CHECK=1 to prevent infinite loop
      expect(execFileSyncSpy.mock.calls[0][2]).toHaveProperty("env");
      expect(execFileSyncSpy.mock.calls[0][2].env.SPAWN_NO_UPDATE_CHECK).toBe("1");

      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      process.argv = originalArgv;
    });

    it("should forward exit code when re-exec fails", async () => {
      const originalArgv = process.argv;
      process.argv = ["/usr/bin/bun", "/usr/local/bin/spawn", "claude", "sprite"];

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "99.0.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { executor } = await import("../update-check.js");
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation(() => {});
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {
        // Re-exec fails with exit code 42
        const err = new Error("Command failed") as Error & { status: number };
        err.status = 42;
        throw err;
      });

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should forward the exit code from the re-exec
      expect(processExitSpy).toHaveBeenCalledWith(42);

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      process.argv = originalArgv;
    });

    it("should re-exec even when run without arguments (bare spawn)", async () => {
      const originalArgv = process.argv;
      process.argv = ["/usr/bin/bun", "/usr/local/bin/spawn"];

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "99.0.0" }),
        } as Response)
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { executor } = await import("../update-check.js");
      const calls: string[] = [];
      const execSyncSpy = spyOn(executor, "execSync").mockImplementation((cmd: string) => {
        calls.push(cmd);
      });
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Two execSync calls: install script + "which spawn" for binary lookup
      expect(calls.length).toBe(2);
      expect(calls[0]).toContain("install.sh");
      expect(calls[1]).toContain("which spawn");

      // execFileSync called once for re-exec (even with no args)
      expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
      expect(execFileSyncSpy.mock.calls[0][1]).toEqual([]);

      // Should show restarting message
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Restarting spawn");

      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execSyncSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      process.argv = originalArgv;
    });
  });
});
