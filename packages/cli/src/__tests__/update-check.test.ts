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
  const originalEnv = {
    ...process.env,
  };
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
    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      // no-op mock - prevent actual exit
    });
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
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "99.0.0",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execFileSync to prevent actual update + re-exec
      const { executor } = await import("../update-check.js");
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });

    it("should auto-update when newer version is available", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "99.0.0",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execFileSync to prevent actual update + re-exec
      const { executor } = await import("../update-check.js");
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should have printed update message to stderr
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Update available");
      expect(output).toContain("99.0.0");
      expect(output).toContain("Updating automatically");

      // Should have called execFileSync for curl, bash, which, and re-exec
      expect(execFileSyncSpy).toHaveBeenCalled();

      // Should have exited
      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execFileSyncSpy.mockRestore();
    });

    it("should not update when up to date", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "0.2.3",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock executor to prevent actual commands
      const { executor } = await import("../update-check.js");
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {});

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should not auto-update (no install script, no re-exec)
      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
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
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "99.0.0",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      // Mock execFileSync to throw an error (curl fetch fails)
      const { executor } = await import("../update-check.js");
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation(() => {
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
      execFileSyncSpy.mockRestore();
    });

    it("should handle bad response format", async () => {
      const mockFetch = mock(() =>
        Promise.resolve(
          new Response("Not Found", {
            status: 404,
          }),
        ),
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
      process.argv = [
        "/usr/bin/bun",
        "/usr/local/bin/spawn",
        "claude",
        "sprite",
      ];

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "99.0.0",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { executor } = await import("../update-check.js");
      const execFileSyncCalls: {
        file: string;
        args: string[];
      }[] = [];
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation((file: string, args: string[]) => {
        execFileSyncCalls.push({
          file,
          args,
        });
      });

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // execFileSync called 4 times: curl (fetch script), bash (run script), which (find binary), re-exec
      expect(execFileSyncCalls.length).toBe(4);
      // 1. curl to fetch install script
      expect(execFileSyncCalls[0].file).toBe("curl");
      expect(execFileSyncCalls[0].args).toContain("-fsSL");
      expect(execFileSyncCalls[0].args.some((a) => a.includes("install.sh"))).toBe(true);
      // 2. bash to execute fetched script
      expect(execFileSyncCalls[1].file).toBe("bash");
      expect(execFileSyncCalls[1].args[0]).toBe("-c");
      // 3. which spawn for binary lookup
      expect(execFileSyncCalls[2].file).toBe("which");
      expect(execFileSyncCalls[2].args).toEqual([
        "spawn",
      ]);
      // 4. re-exec with original args
      expect(execFileSyncCalls[3].args).toEqual([
        "claude",
        "sprite",
      ]);

      // Should show rerunning message
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Rerunning");

      // Should set SPAWN_NO_UPDATE_CHECK=1 to prevent infinite loop
      const reexecCall = execFileSyncSpy.mock.calls[3];
      expect(reexecCall[2]).toHaveProperty("env");
      expect(reexecCall[2].env.SPAWN_NO_UPDATE_CHECK).toBe("1");

      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      process.argv = originalArgv;
    });

    it("should forward exit code when re-exec fails", async () => {
      const originalArgv = process.argv;
      process.argv = [
        "/usr/bin/bun",
        "/usr/local/bin/spawn",
        "claude",
        "sprite",
      ];

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "99.0.0",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { executor } = await import("../update-check.js");
      let callCount = 0;
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation((file: string) => {
        callCount++;
        // First 3 calls succeed (curl, bash, which), 4th call (re-exec) fails
        if (callCount >= 4) {
          const err = new Error("Command failed");
          Object.assign(err, {
            status: 42,
          });
          throw err;
        }
      });

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // Should forward the exit code from the re-exec
      expect(processExitSpy).toHaveBeenCalledWith(42);

      fetchSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      process.argv = originalArgv;
    });

    it("should re-exec even when run without arguments (bare spawn)", async () => {
      const originalArgv = process.argv;
      process.argv = [
        "/usr/bin/bun",
        "/usr/local/bin/spawn",
      ];

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: "99.0.0",
            }),
          ),
        ),
      );
      const fetchSpy = spyOn(global, "fetch").mockImplementation(mockFetch);

      const { executor } = await import("../update-check.js");
      const execFileSyncCalls: {
        file: string;
        args: string[];
      }[] = [];
      const execFileSyncSpy = spyOn(executor, "execFileSync").mockImplementation((file: string, args: string[]) => {
        execFileSyncCalls.push({
          file,
          args,
        });
      });

      const { checkForUpdates } = await import("../update-check.js");
      await checkForUpdates();

      // execFileSync called 4 times: curl, bash, which, re-exec
      expect(execFileSyncCalls.length).toBe(4);
      expect(execFileSyncCalls[0].file).toBe("curl");
      expect(execFileSyncCalls[1].file).toBe("bash");
      expect(execFileSyncCalls[2].file).toBe("which");
      // re-exec with no args
      expect(execFileSyncCalls[3].args).toEqual([]);

      // Should show restarting message
      const output = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Restarting spawn");

      expect(processExitSpy).toHaveBeenCalledWith(0);

      fetchSpy.mockRestore();
      execFileSyncSpy.mockRestore();
      process.argv = originalArgv;
    });
  });
});
