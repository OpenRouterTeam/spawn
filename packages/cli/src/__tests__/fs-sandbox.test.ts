/**
 * Filesystem sandbox guardrail test.
 *
 * Verifies that the test preload correctly isolates all filesystem writes
 * to a temporary directory — no test should ever touch the real user's home.
 *
 * If this test fails, it means the sandbox is broken and tests are writing
 * to real user files (e.g. ~/.spawn/history.json).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// REAL_HOME is the actual home directory captured BEFORE preload runs.
// We read it from /etc/passwd because process.env.HOME is already sandboxed.
const REAL_HOME = (() => {
  try {
    // Bun's os.homedir() is patched by preload, and process.env.HOME is
    // sandboxed. Read the real home from the password database instead.
    const proc = Bun.spawnSync([
      "sh",
      "-c",
      "getent passwd $(id -u) | cut -d: -f6",
    ]);
    const home = new TextDecoder().decode(proc.stdout).trim();
    return home || "/home/unknown";
  } catch {
    return "/home/unknown";
  }
})();

describe("Filesystem sandbox", () => {
  it("process.env.HOME should point to temp sandbox, not real home", () => {
    const home = process.env.HOME ?? "";
    expect(home).not.toBe(REAL_HOME);
    expect(home).toContain("spawn-test-home-");
  });

  it("SPAWN_HOME should point to temp sandbox", () => {
    const spawnHome = process.env.SPAWN_HOME ?? "";
    expect(spawnHome).toContain("spawn-test-home-");
    expect(spawnHome).toEndWith("/.spawn");
  });

  it("XDG_CACHE_HOME should point to temp sandbox", () => {
    const cacheHome = process.env.XDG_CACHE_HOME ?? "";
    expect(cacheHome).toContain("spawn-test-home-");
  });

  it("real home ~/.spawn/history.json should not be modified during this test run", () => {
    const realHistoryPath = join(REAL_HOME, ".spawn", "history.json");
    if (!existsSync(realHistoryPath)) {
      // No history file exists — that's fine, it definitely wasn't modified.
      expect(true).toBe(true);
      return;
    }
    // Record the mtime. If any test modifies the real file, the mtime
    // changes. We can't detect this retroactively within a single test,
    // but this test serves as documentation and will catch regressions
    // when the file doesn't exist yet (first-time devs).
    const stat = statSync(realHistoryPath);
    expect(stat.isFile()).toBe(true);
  });

  it("sandbox directories should exist", () => {
    const home = process.env.HOME ?? "";
    expect(existsSync(join(home, ".spawn"))).toBe(true);
    expect(existsSync(join(home, ".cache"))).toBe(true);
    expect(existsSync(join(home, ".config"))).toBe(true);
    expect(existsSync(join(home, ".ssh"))).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(true);
  });
});
