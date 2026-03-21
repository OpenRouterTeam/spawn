/**
 * update-check-cov.test.ts — Coverage tests for update-check.ts
 *
 * Focuses on uncovered paths: compareVersions edge cases, fetchLatestVersion fallback,
 * findUpdatedBinary, reExecWithArgs, performAutoUpdate success/failure,
 * isUpdateBackedOff, markUpdateFailed, isUpdateCheckedRecently, markUpdateChecked,
 * checkForUpdates integration, printUpdateBanner.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { tryCatch } from "@openrouter/spawn-shared";

function clearUpdateBackoff() {
  tryCatch(() => fs.unlinkSync(path.join(process.env.HOME || "/tmp", ".config", "spawn", ".update-failed")));
}

function clearUpdateChecked() {
  tryCatch(() => fs.unlinkSync(path.join(process.env.HOME || "/tmp", ".config", "spawn", ".update-checked")));
}

function writeUpdateFailed(timestamp: number) {
  const dir = path.join(process.env.HOME || "/tmp", ".config", "spawn");
  fs.mkdirSync(dir, {
    recursive: true,
  });
  fs.writeFileSync(path.join(dir, ".update-failed"), String(timestamp));
}

function writeUpdateChecked(timestamp: number) {
  const dir = path.join(process.env.HOME || "/tmp", ".config", "spawn");
  fs.mkdirSync(dir, {
    recursive: true,
  });
  fs.writeFileSync(path.join(dir, ".update-checked"), String(timestamp));
}

describe("update-check.ts coverage", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleSpy: ReturnType<typeof spyOn>;
  let processExitSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalEnv = {
      ...process.env,
    };
    originalFetch = global.fetch;
    process.env.NODE_ENV = undefined;
    process.env.BUN_ENV = undefined;
    process.env.SPAWN_NO_UPDATE_CHECK = undefined;
    clearUpdateBackoff();
    clearUpdateChecked();
    consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  // ── checkForUpdates skip conditions ────────────────────────────────────

  describe("checkForUpdates skip conditions", () => {
    it("skips in test environment (NODE_ENV=test)", async () => {
      process.env.NODE_ENV = "test";
      global.fetch = mock(async () => new Response("1.0.0"));
      const { checkForUpdates } = await import("../update-check");
      await checkForUpdates();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("skips when SPAWN_NO_UPDATE_CHECK=1", async () => {
      process.env.SPAWN_NO_UPDATE_CHECK = "1";
      global.fetch = mock(async () => new Response("1.0.0"));
      const { checkForUpdates } = await import("../update-check");
      await checkForUpdates();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("skips when recently backed off", async () => {
      writeUpdateFailed(Date.now()); // failed just now
      global.fetch = mock(async () => new Response("1.0.0"));
      const { checkForUpdates } = await import("../update-check");
      await checkForUpdates();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("skips when recently checked successfully", async () => {
      writeUpdateChecked(Date.now()); // checked just now
      global.fetch = mock(async () => new Response("1.0.0"));
      const { checkForUpdates } = await import("../update-check");
      await checkForUpdates();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── checkForUpdates when up to date ────────────────────────────────────

  describe("checkForUpdates when current", () => {
    it("does nothing when already on latest version", async () => {
      const { checkForUpdates } = await import("../update-check");
      const pkg = await import("../../package.json");
      const currentVersion = pkg.version;

      global.fetch = mock(async () => new Response(currentVersion));
      await checkForUpdates();
      // Should mark as checked but not trigger update
      const checkedPath = path.join(process.env.HOME || "/tmp", ".config", "spawn", ".update-checked");
      expect(fs.existsSync(checkedPath)).toBe(true);
    });
  });

  // ── checkForUpdates fetch failure ──────────────────────────────────────

  describe("checkForUpdates fetch failure", () => {
    it("handles fetch returning null version gracefully", async () => {
      const { checkForUpdates } = await import("../update-check");
      global.fetch = mock(async () => new Response("not-a-version"));
      // Should not throw — verify by confirming fetch was called and function completed
      await expect(checkForUpdates()).resolves.toBeUndefined();
      expect(global.fetch).toHaveBeenCalled();
    });

    it("handles fetch network error gracefully", async () => {
      const { checkForUpdates } = await import("../update-check");
      global.fetch = mock(async () => {
        throw new TypeError("fetch failed");
      });
      // Should not throw — verify by confirming function completes without rejection
      await expect(checkForUpdates()).resolves.toBeUndefined();
    });
  });

  // ── Backoff edge cases ────────────────────────────────────────────────

  describe("backoff edge cases", () => {
    it("does not back off when failed timestamp is old (>1h)", async () => {
      writeUpdateFailed(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      const { checkForUpdates } = await import("../update-check");
      const pkg = await import("../../package.json");
      global.fetch = mock(async () => new Response(pkg.version));
      await checkForUpdates();
      // Should proceed with check (not backed off) — fetch was called
      expect(global.fetch).toHaveBeenCalled();
    });

    it("does not skip when checked timestamp is old (>1h)", async () => {
      writeUpdateChecked(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      const { checkForUpdates } = await import("../update-check");
      const pkg = await import("../../package.json");
      global.fetch = mock(async () => new Response(pkg.version));
      await checkForUpdates();
      // Should proceed with network check — fetch was called
      expect(global.fetch).toHaveBeenCalled();
    });

    it("handles NaN in .update-failed file", async () => {
      const dir = path.join(process.env.HOME || "/tmp", ".config", "spawn");
      fs.mkdirSync(dir, {
        recursive: true,
      });
      fs.writeFileSync(path.join(dir, ".update-failed"), "not-a-number");

      const { checkForUpdates } = await import("../update-check");
      const pkg = await import("../../package.json");
      global.fetch = mock(async () => new Response(pkg.version));
      await checkForUpdates();
      // NaN timestamp is not treated as recent failure — fetch proceeds
      expect(global.fetch).toHaveBeenCalled();
    });

    it("handles NaN in .update-checked file", async () => {
      const dir = path.join(process.env.HOME || "/tmp", ".config", "spawn");
      fs.mkdirSync(dir, {
        recursive: true,
      });
      fs.writeFileSync(path.join(dir, ".update-checked"), "not-a-number");

      const { checkForUpdates } = await import("../update-check");
      const pkg = await import("../../package.json");
      global.fetch = mock(async () => new Response(pkg.version));
      await checkForUpdates();
      // NaN timestamp is not treated as recent check — fetch proceeds
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
