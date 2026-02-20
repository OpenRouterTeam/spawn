import { describe, it, expect } from "bun:test";
import { existsSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

/**
 * Sandbox verification tests.
 *
 * These tests verify that the preload.ts script successfully sandboxes
 * all filesystem operations to prevent tests from accidentally writing
 * to the real user's home directory.
 *
 * This addresses issue #1373: [Bug]: Sandbox all CLI tests
 *
 * Agent: test-engineer
 */

describe("Test Sandbox Verification", () => {
  describe("Environment variables", () => {
    it("should sandbox HOME to a temp directory", () => {
      const home = process.env.HOME!;
      expect(home).toBeDefined();
      expect(home).toMatch(/\/tmp\/spawn-test-home-/);
      expect(home).not.toBe("/root");
      expect(home).not.toBe("/home");
    });

    it("should sandbox XDG_CONFIG_HOME", () => {
      const xdgConfig = process.env.XDG_CONFIG_HOME!;
      expect(xdgConfig).toBeDefined();
      expect(xdgConfig).toMatch(/\/tmp\/spawn-test-home-/);
      expect(xdgConfig).toContain("/.config");
      expect(existsSync(xdgConfig)).toBe(true);
    });

    it("should sandbox XDG_CACHE_HOME", () => {
      const xdgCache = process.env.XDG_CACHE_HOME!;
      expect(xdgCache).toBeDefined();
      expect(xdgCache).toMatch(/\/tmp\/spawn-test-home-/);
      expect(xdgCache).toContain("/.cache");
      expect(existsSync(xdgCache)).toBe(true);
    });

    it("should sandbox XDG_DATA_HOME", () => {
      const xdgData = process.env.XDG_DATA_HOME!;
      expect(xdgData).toBeDefined();
      expect(xdgData).toMatch(/\/tmp\/spawn-test-home-/);
      expect(xdgData).toContain("/.local/share");
      expect(existsSync(xdgData)).toBe(true);
    });
  });

  describe("Pre-created directories", () => {
    it("should pre-create .config directory", () => {
      const configDir = join(process.env.HOME!, ".config");
      expect(existsSync(configDir)).toBe(true);
    });

    it("should pre-create .cache directory", () => {
      const cacheDir = join(process.env.HOME!, ".cache");
      expect(existsSync(cacheDir)).toBe(true);
    });

    it("should pre-create .claude directory", () => {
      const claudeDir = join(process.env.HOME!, ".claude");
      expect(existsSync(claudeDir)).toBe(true);
    });

    it("should pre-create .ssh directory", () => {
      const sshDir = join(process.env.HOME!, ".ssh");
      expect(existsSync(sshDir)).toBe(true);
    });

    it("should pre-create .local/share directory", () => {
      const localShareDir = join(process.env.HOME!, ".local", "share");
      expect(existsSync(localShareDir)).toBe(true);
    });
  });

  describe("Filesystem isolation", () => {
    it("should allow writing to sandboxed home directory", () => {
      const testFile = join(process.env.HOME!, "test-write.txt");
      writeFileSync(testFile, "test content");
      expect(existsSync(testFile)).toBe(true);
      expect(readFileSync(testFile, "utf-8")).toBe("test content");
      rmSync(testFile);
    });

    it("should allow writing to sandboxed .config", () => {
      const testFile = join(process.env.HOME!, ".config", "test.json");
      writeFileSync(testFile, '{"test": true}');
      expect(existsSync(testFile)).toBe(true);
      rmSync(testFile);
    });

    it("should allow writing to sandboxed .ssh", () => {
      const testFile = join(process.env.HOME!, ".ssh", "test_key");
      writeFileSync(testFile, "test key content");
      expect(existsSync(testFile)).toBe(true);
      rmSync(testFile);
    });
  });

  describe("Subprocess isolation", () => {
    it("should inherit sandboxed HOME in bash subprocesses", () => {
      const result = spawnSync("bash", ["-c", "echo $HOME"], {
        encoding: "utf-8",
        env: { ...process.env },
      });
      expect(result.stdout.trim()).toMatch(/\/tmp\/spawn-test-home-/);
      expect(result.stdout.trim()).not.toBe("/root");
    });

    it("should prevent subprocesses from writing to real home", () => {
      // Clean up any stale artifact from previous unsandboxed test runs
      if (existsSync("/root/subprocess-test.txt")) {
        rmSync("/root/subprocess-test.txt");
      }

      // Create a test file in the sandboxed home via subprocess
      const testFile = join(process.env.HOME!, "subprocess-test.txt");
      const result = spawnSync(
        "bash",
        ["-c", `echo "test" > "$HOME/subprocess-test.txt"`],
        {
          encoding: "utf-8",
          env: { ...process.env },
        }
      );

      // File should exist in sandboxed home, not real home
      expect(existsSync(testFile)).toBe(true);
      expect(existsSync("/root/subprocess-test.txt")).toBe(false);

      // Cleanup
      rmSync(testFile);
    });
  });

  describe("Safety guarantees", () => {
    it("should never expose /root as HOME", () => {
      expect(process.env.HOME).not.toBe("/root");
      expect(process.env.HOME).not.toContain("/root/.config");
      expect(process.env.HOME).not.toContain("/root/.ssh");
    });

    it("should never expose real user home as XDG_CONFIG_HOME", () => {
      expect(process.env.XDG_CONFIG_HOME).not.toBe("/root/.config");
      expect(process.env.XDG_CONFIG_HOME).not.toBe("/home/.config");
    });

    it("should use a unique temp directory for each test run", () => {
      // The temp directory should have a random suffix
      expect(process.env.HOME).toMatch(/spawn-test-home-[a-zA-Z0-9]+$/);
    });
  });
});
