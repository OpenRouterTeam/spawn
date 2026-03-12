/**
 * Test preload script — filesystem isolation for CLI tests.
 *
 * Loaded before every test file via bunfig.toml `preload`.
 * Redirects HOME and XDG dirs to a temp directory so no test
 * can accidentally write to the real user's home directory
 * (e.g. ~/.claude/settings.json, ~/.zshrc, ~/.ssh/id_rsa).
 *
 * This prevents the class of bugs where a test (or the code under test)
 * overwrites real config files on the developer's machine.
 *
 * SANDBOXING STRATEGY:
 * 1. Creates a unique temp directory for each test run
 * 2. Sets process.env.HOME, SPAWN_HOME, and all XDG_* variables to temp paths
 * 3. Mocks os.homedir() to return the sandboxed HOME
 * 4. Pre-creates common directories (~/.config, ~/.ssh, ~/.claude, ~/.spawn, etc.)
 * 5. Cleans up the temp directory on process exit
 *
 * This ensures that:
 * - Direct filesystem writes (fs.writeFileSync("~/.config/...")) are safe
 * - Environment variable reads (process.env.HOME) point to temp
 * - Node.js API calls (os.homedir()) return the sandboxed path
 * - Subprocesses (execSync, spawnSync) inherit the sandboxed environment
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCatch } from "@openrouter/spawn-shared";

// ── Stray test file cleanup ──────────────────────────────────────────────────
//
// Automated refactor/discovery agents occasionally run tests from outside the
// cli/ directory, where bunfig.toml is not loaded and this preload never runs.
// In those cases HOME remains the real home directory (/root on CI), so any
// test that writes "$HOME/subprocess-test-*.txt" leaves files there.
//
// We clean up before and after every test run to keep the working tree tidy.

const REAL_HOME = process.env.HOME ?? "";

function cleanupStrayTestFiles(): void {
  if (!REAL_HOME) {
    return;
  }
  tryCatch(() => {
    for (const f of readdirSync(REAL_HOME)) {
      if (f.startsWith("subprocess-test-") && f.endsWith(".txt")) {
        rmSync(join(REAL_HOME, f), {
          force: true,
        });
      }
    }
  });
}

cleanupStrayTestFiles();

// ── Create isolated HOME ────────────────────────────────────────────────────

const TEST_HOME = mkdtempSync(join(tmpdir(), "spawn-test-home-"));

// Redirect all user-directory env vars to the isolated temp
process.env.HOME = TEST_HOME;
process.env.XDG_CACHE_HOME = join(TEST_HOME, ".cache");
process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");
process.env.XDG_DATA_HOME = join(TEST_HOME, ".local", "share");

// ── IMPORTANT: Bun's os.homedir() ignores process.env.HOME ──────────────
//
// Bun's os.homedir() reads from getpwuid() and never re-checks env vars.
// Named imports (`import { homedir } from "node:os"`) capture a binding to
// the native function, so patching `os.homedir` on the default export does
// NOT propagate to other modules' destructured imports.
//
// The ONLY reliable way to sandbox homedir in tests is to ensure all code
// uses `process.env.HOME` (which the preload controls) rather than calling
// `homedir()` directly. Production code uses `getUserHome()` from
// shared/ui.ts; test files should use `process.env.HOME ?? ""`.
//
// This default-export patch catches direct `os.homedir()` calls (rare) but
// cannot fix `import { homedir } from "node:os"` in other modules.
os.homedir = () => TEST_HOME;

// Set SPAWN_HOME so history/config writes go to the sandbox even if a test
// forgets to set it. Individual tests can override this, but the default is safe.
process.env.SPAWN_HOME = join(TEST_HOME, ".spawn");

// Pre-create common directories tests might expect
mkdirSync(join(TEST_HOME, ".spawn"), {
  recursive: true,
});
mkdirSync(join(TEST_HOME, ".cache"), {
  recursive: true,
});
mkdirSync(join(TEST_HOME, ".config"), {
  recursive: true,
});
mkdirSync(join(TEST_HOME, ".claude"), {
  recursive: true,
});
mkdirSync(join(TEST_HOME, ".ssh"), {
  recursive: true,
});
mkdirSync(join(TEST_HOME, ".local", "share"), {
  recursive: true,
});

// ── Cleanup on exit ─────────────────────────────────────────────────────────

process.on("exit", () => {
  tryCatch(() =>
    rmSync(TEST_HOME, {
      recursive: true,
      force: true,
    }),
  );
  cleanupStrayTestFiles();
});
