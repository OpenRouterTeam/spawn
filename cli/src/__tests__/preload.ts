/**
 * Test preload script — filesystem isolation for CLI tests.
 *
 * Loaded before every test file via bunfig.toml `preload`.
 * Redirects HOME and XDG dirs to a temp directory so no test
 * can accidentally write to the real user's home directory
 * (e.g. ~/.claude/settings.json, ~/.zshrc).
 *
 * This prevents the class of bugs where a test (or the code under test)
 * overwrites real config files on the developer's machine.
 */

import { mkdirSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Create isolated HOME ────────────────────────────────────────────────────

const TEST_HOME = mkdtempSync(join(tmpdir(), "spawn-test-home-"));

// Redirect all user-directory env vars to the isolated temp
process.env.HOME = TEST_HOME;
process.env.XDG_CACHE_HOME = join(TEST_HOME, ".cache");
process.env.XDG_CONFIG_HOME = join(TEST_HOME, ".config");
process.env.XDG_DATA_HOME = join(TEST_HOME, ".local", "share");

// Pre-create common directories tests might expect
mkdirSync(join(TEST_HOME, ".cache"), { recursive: true });
mkdirSync(join(TEST_HOME, ".config"), { recursive: true });
mkdirSync(join(TEST_HOME, ".claude"), { recursive: true });
mkdirSync(join(TEST_HOME, ".local", "share"), { recursive: true });

// ── Cleanup on exit ─────────────────────────────────────────────────────────

process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});
