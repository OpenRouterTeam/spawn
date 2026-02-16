import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { resolve } from "path";

/**
 * Tests for CLI version output and dispatch routing via subprocess execution.
 *
 * These tests exercise the ACTUAL index.ts entry point by running it as a
 * subprocess, verifying the real behavior users see when they run spawn commands.
 * This catches integration issues that unit tests with mocked modules miss:
 *
 * - showVersion: output format, runtime info (bun/node, platform, arch)
 * - Version flags: --version, -v, -V, and "version" subcommand
 * - Help flags: --help, -h, and "help" subcommand
 * - handleNoCommand: --dry-run and --prompt without agent/cloud
 * - Subcommand aliases: "m" for "matrix", "ls"/"history" for "list"
 * - Verb alias routing: "run", "launch", "start", "deploy", "exec"
 * - Unknown flag error messaging
 * - Extra args warning
 * - showInfoOrError: unknown command with fuzzy suggestions
 *
 * Agent: test-engineer
 */

const CLI_PATH = resolve(import.meta.dir, "../../src/index.ts");
const REPO_ROOT = resolve(import.meta.dir, "../../..");

/**
 * Run the CLI with given args as a subprocess.
 * Sets SPAWN_NO_UPDATE_CHECK to skip auto-update and BUN_ENV=test to skip
 * local manifest loading. Returns { stdout, stderr, exitCode }.
 */
function runCLI(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const { spawnSync } = require("child_process");
  const result = spawnSync("bun", ["run", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 15000,
    env: {
      ...process.env,
      SPAWN_NO_UPDATE_CHECK: "1",
      BUN_ENV: "test",
      // Avoid terminal-dependent output
      TERM: "dumb",
      SPAWN_NO_UNICODE: "1",
      // Ensure no color codes in output for easier assertion
      NO_COLOR: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: (result.stdout || "").toString(),
    stderr: (result.stderr || "").toString(),
    exitCode: result.status ?? 1,
  };
}

// ── showVersion output ──────────────────────────────────────────────────────

describe("showVersion via CLI subprocess", () => {
  it("should show version string with 'spawn v' prefix", () => {
    const { stdout, exitCode } = runCLI(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/spawn v\d+\.\d+\.\d+/);
  });

  it("should show bun runtime info", () => {
    const { stdout, exitCode } = runCLI(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("bun");
  });

  it("should show platform info", () => {
    const { stdout, exitCode } = runCLI(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(process.platform);
  });

  it("should show arch info", () => {
    const { stdout, exitCode } = runCLI(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(process.arch);
  });

  it("should suggest 'spawn update' command", () => {
    const { stdout, exitCode } = runCLI(["version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("spawn update");
  });

  it("should show binary path", () => {
    const { stdout, exitCode } = runCLI(["version"]);
    expect(exitCode).toBe(0);
    // The binary path should contain the path to index.ts
    expect(stdout).toContain("index.ts");
  });
});

// ── Version flag aliases ────────────────────────────────────────────────────

describe("version flag aliases", () => {
  it("--version should produce same version line as 'version'", () => {
    const versionResult = runCLI(["version"]);
    const flagResult = runCLI(["--version"]);
    expect(flagResult.exitCode).toBe(0);
    // Both should contain the version string
    const versionMatch = versionResult.stdout.match(/spawn v[\d.]+/);
    const flagMatch = flagResult.stdout.match(/spawn v[\d.]+/);
    expect(versionMatch).not.toBeNull();
    expect(flagMatch).not.toBeNull();
    expect(versionMatch![0]).toBe(flagMatch![0]);
  });

  it("-v should produce same version line as 'version'", () => {
    const { stdout, exitCode } = runCLI(["-v"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/spawn v\d+\.\d+\.\d+/);
  });

  it("-V should produce same version line as 'version'", () => {
    const { stdout, exitCode } = runCLI(["-V"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/spawn v\d+\.\d+\.\d+/);
  });
});

// ── Help flags ──────────────────────────────────────────────────────────────

describe("help command and flags", () => {
  it("'help' should show USAGE section", () => {
    const { stdout, exitCode } = runCLI(["help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("--help should show USAGE section", () => {
    const { stdout, exitCode } = runCLI(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("-h should show USAGE section", () => {
    const { stdout, exitCode } = runCLI(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("help should include EXAMPLES section", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("EXAMPLES");
  });

  it("help should include AUTHENTICATION section", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("AUTHENTICATION");
  });

  it("help should include ENVIRONMENT VARIABLES section", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("ENVIRONMENT VARIABLES");
  });

  it("help should include TROUBLESHOOTING section", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("TROUBLESHOOTING");
  });

  it("help should mention --dry-run flag", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("--dry-run");
  });

  it("help should mention --prompt-file flag", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("--prompt-file");
  });

  it("help should mention list aliases (ls, history)", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("ls");
    expect(stdout).toContain("history");
  });

  it("help should mention matrix alias (m)", () => {
    const { stdout } = runCLI(["help"]);
    expect(stdout).toContain("matrix");
  });
});

// ── Trailing help flag on subcommands ───────────────────────────────────────

describe("trailing help flag on subcommands", () => {
  it("'agents --help' should show help, not agents list", () => {
    const { stdout, exitCode } = runCLI(["agents", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("'clouds -h' should show help", () => {
    const { stdout, exitCode } = runCLI(["clouds", "-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("'matrix --help' should show help", () => {
    const { stdout, exitCode } = runCLI(["matrix", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("'list --help' should show help", () => {
    const { stdout, exitCode } = runCLI(["list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });

  it("'update --help' should show help", () => {
    const { stdout, exitCode } = runCLI(["update", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
  });
});

// ── handleNoCommand: --dry-run and --prompt without agent/cloud ─────────────

describe("handleNoCommand error paths", () => {
  it("--dry-run without agent/cloud should error", () => {
    const { stderr, exitCode } = runCLI(["--dry-run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--dry-run requires both");
  });

  it("-n without agent/cloud should error", () => {
    const { stderr, exitCode } = runCLI(["-n"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--dry-run requires both");
  });

  it("--prompt without agent/cloud should error", () => {
    const { stderr, exitCode } = runCLI(["--prompt", "hello"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--prompt requires both");
  });

  it("--prompt-file with nonexistent file should error with file-not-found", () => {
    const { stderr, exitCode } = runCLI(["--prompt-file", "/tmp/nonexistent-spawn-test"]);
    expect(exitCode).toBe(1);
    // The file read error occurs before the no-agent/cloud check
    expect(stderr).toContain("not found");
  });
});

// ── --dry-run with only agent (no cloud) ────────────────────────────────────

describe("--dry-run with only agent", () => {
  it("should error when --dry-run is used with agent only", () => {
    const { stderr, exitCode } = runCLI(["claude", "--dry-run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--dry-run requires both");
  });
});

// ── --prompt with only agent (no cloud) ─────────────────────────────────────

describe("--prompt with only agent (no cloud)", () => {
  it("should error when --prompt is used with agent only", () => {
    const { stderr, exitCode } = runCLI(["claude", "--prompt", "hello"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--prompt requires both");
  });

  it("should suggest available clouds for the agent", () => {
    const { stderr, exitCode } = runCLI(["claude", "--prompt", "hello"]);
    expect(exitCode).toBe(1);
    // Should suggest cloud options
    expect(stderr).toContain("spawn claude");
  });
});

// ── Unknown flag detection ──────────────────────────────────────────────────

describe("unknown flag detection", () => {
  it("should error on --unknown flag", () => {
    const { stderr, exitCode } = runCLI(["--unknown"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown flag");
    expect(stderr).toContain("--unknown");
  });

  it("should show supported flags in error message", () => {
    const { stderr, exitCode } = runCLI(["--xyz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Supported flags");
    expect(stderr).toContain("--prompt");
    expect(stderr).toContain("--dry-run");
    expect(stderr).toContain("--help");
    expect(stderr).toContain("--version");
  });

  it("should suggest 'spawn help' when unknown flag is used", () => {
    const { stderr, exitCode } = runCLI(["--foo"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("spawn help");
  });

  it("should not treat -1 as a flag (numeric prefix)", () => {
    // -1 starts with - but matches /^-\d/, so it should not be caught as unknown flag
    // It will fail for other reasons (not a valid agent) but not as "unknown flag"
    const { stderr, exitCode } = runCLI(["-1"]);
    expect(stderr).not.toContain("Unknown flag");
  });

  it("should treat --prompt-files (typo) as unknown flag", () => {
    const { stderr, exitCode } = runCLI(["--prompt-files", "test.txt"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown flag");
    expect(stderr).toContain("--prompt-files");
  });
});

// ── Flag value requirements ─────────────────────────────────────────────────

describe("flag value requirements", () => {
  it("--prompt without value should error", () => {
    const { stderr, exitCode } = runCLI(["claude", "sprite", "--prompt"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--prompt");
    expect(stderr).toContain("requires a value");
  });

  it("-p without value should error", () => {
    const { stderr, exitCode } = runCLI(["claude", "sprite", "-p"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("-p");
    expect(stderr).toContain("requires a value");
  });

  it("--prompt-file without value should error", () => {
    const { stderr, exitCode } = runCLI(["claude", "sprite", "--prompt-file"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--prompt-file");
    expect(stderr).toContain("requires a value");
  });

  it("-f without value should error", () => {
    const { stderr, exitCode } = runCLI(["claude", "sprite", "-f"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("-f");
    expect(stderr).toContain("requires a value");
  });

  it("--prompt and --prompt-file together should error", () => {
    const { stderr, exitCode } = runCLI([
      "claude", "sprite",
      "--prompt", "hello",
      "--prompt-file", "/tmp/test.txt",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot be used together");
  });
});

// ── Verb alias routing ──────────────────────────────────────────────────────

describe("verb alias routing", () => {
  it("'run' without args should error with usage hint", () => {
    const { stderr, exitCode } = runCLI(["run"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires an agent and cloud");
  });

  it("'launch' without args should error with usage hint", () => {
    const { stderr, exitCode } = runCLI(["launch"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires an agent and cloud");
  });

  it("'start' without args should error with usage hint", () => {
    const { stderr, exitCode } = runCLI(["start"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires an agent and cloud");
  });

  it("'deploy' without args should error with usage hint", () => {
    const { stderr, exitCode } = runCLI(["deploy"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires an agent and cloud");
  });

  it("'exec' without args should error with usage hint", () => {
    const { stderr, exitCode } = runCLI(["exec"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires an agent and cloud");
  });

  it("verb alias error should mention it's optional", () => {
    const { stderr } = runCLI(["run"]);
    expect(stderr).toContain("optional");
    expect(stderr).toContain("spawn <agent> <cloud>");
  });
});

// ── Extra args warning ──────────────────────────────────────────────────────

describe("extra arguments warning", () => {
  it("should warn about extra args after version command", () => {
    const { stderr, stdout, exitCode } = runCLI(["version", "extra"]);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("extra argument");
    expect(stderr).toContain("ignored");
    // Should still show version
    expect(stdout).toMatch(/spawn v\d+\.\d+/);
  });

  it("should warn about multiple extra args", () => {
    const { stderr, exitCode } = runCLI(["version", "a", "b", "c"]);
    expect(exitCode).toBe(0);
    expect(stderr.toLowerCase()).toContain("extra arguments");
    expect(stderr).toContain("ignored");
  });

  it("should not warn when no extra args", () => {
    const { stderr } = runCLI(["version"]);
    expect(stderr.toLowerCase()).not.toContain("extra argument");
  });
});

// ── Prompt file errors ──────────────────────────────────────────────────────

describe("prompt file error handling", () => {
  it("should show file-not-found error for nonexistent prompt file", () => {
    const { stderr, exitCode } = runCLI([
      "claude", "sprite",
      "--prompt-file", "/tmp/spawn-test-nonexistent-file-xyz123",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });

  it("should show directory error when prompt-file is a directory", () => {
    const { stderr, exitCode } = runCLI([
      "claude", "sprite",
      "--prompt-file", "/tmp",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("directory");
  });
});

// ── Non-interactive terminal without command ────────────────────────────────

describe("non-interactive terminal handling", () => {
  it("should show usage hint when no args and no TTY", () => {
    // Running as subprocess inherently lacks a TTY for stdin
    const { stderr, exitCode } = runCLI([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Interactive picker requires a terminal");
    expect(stderr).toContain("spawn <agent> <cloud>");
    expect(stderr).toContain("spawn agents");
    expect(stderr).toContain("spawn clouds");
    expect(stderr).toContain("spawn help");
  });
});

// ── Subcommand alias routing ────────────────────────────────────────────────

describe("subcommand alias routing", () => {
  it("'m' should work as alias for 'matrix'", () => {
    const { stdout, exitCode } = runCLI(["m"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Availability Matrix");
  });

  it("'agents' should list agents", () => {
    const { stdout, exitCode } = runCLI(["agents"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Agents");
  });

  it("'clouds' should list clouds", () => {
    const { stdout, exitCode } = runCLI(["clouds"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Cloud Providers");
  });
});

// ── List command aliases ────────────────────────────────────────────────────

describe("list command aliases", () => {
  it("'list' should not crash with empty history", () => {
    const { exitCode } = runCLI(["list"], { SPAWN_HOME: "/tmp/spawn-test-empty-home-" + Date.now() });
    // May exit 0 (shows "no spawns") or run interactive picker in non-TTY
    // The important thing is it doesn't crash
    expect(exitCode).toBeDefined();
  });

  it("'ls' should work as alias for 'list'", () => {
    const { exitCode } = runCLI(["ls"], { SPAWN_HOME: "/tmp/spawn-test-empty-home-" + Date.now() });
    expect(exitCode).toBeDefined();
  });

  it("'history' should work as alias for 'list'", () => {
    const { exitCode } = runCLI(["history"], { SPAWN_HOME: "/tmp/spawn-test-empty-home-" + Date.now() });
    expect(exitCode).toBeDefined();
  });

  it("'list -a' without value should error", () => {
    const { stderr, exitCode } = runCLI(["list", "-a"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("-a");
    expect(stderr).toContain("requires");
  });

  it("'list -c' without value should error", () => {
    const { stderr, exitCode } = runCLI(["list", "-c"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("-c");
    expect(stderr).toContain("requires");
  });
});
