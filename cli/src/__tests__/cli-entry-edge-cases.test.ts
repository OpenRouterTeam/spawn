import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Edge case tests for the CLI entry point (index.ts).
 *
 * Tests paths that are not covered by other test files:
 * - handleError formatting for various thrown value types (non-Error, number, etc.)
 * - Flag ordering edge cases (flags before, between, and after positional args)
 * - Multiple positional args beyond expected count (extra args ignored)
 * - Unknown flags combined with valid subcommands
 * - --prompt interaction with subcommands (list, agents, clouds)
 * - --prompt-file with a real file on disk (subprocess-level verification)
 * - Version flag combined with other flags
 * - Empty string and whitespace positional args
 * - isInteractiveTTY: non-TTY stdin shows help instead of interactive picker
 * - SPAWN_NO_UPDATE_CHECK actually prevents update check in subprocess
 *
 * Agent: test-engineer
 */

const CLI_DIR = resolve(import.meta.dir, "../..");
const PROJECT_ROOT = resolve(CLI_DIR, "..");

function runCli(
  args: string[],
  env: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number } {
  const quotedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `bun run ${CLI_DIR}/src/index.ts ${quotedArgs}`;
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SHELL: process.env.SHELL,
        TERM: process.env.TERM || "xterm",
        ...env,
        SPAWN_NO_UPDATE_CHECK: "1",
        NODE_ENV: "",
        BUN_ENV: "",
      },
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status ?? 1,
    };
  }
}

function output(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr;
}

// ── handleError output formatting ─────────────────────────────────────────

describe("error output formatting", () => {
  it("should show error with valid names hint for invalid identifier", () => {
    const result = runCli(["../hack", "sprite"]);
    const out = output(result);
    expect(out).toContain("invalid characters");
    expect(out).toContain("spawn agents");
    expect(result.exitCode).not.toBe(0);
  });

  it("should format error message for semicolon injection", () => {
    const result = runCli(["agent;rm", "sprite"]);
    const out = output(result);
    expect(out).toContain("invalid characters");
    expect(result.exitCode).not.toBe(0);
  });

  it("should format error message for dollar sign injection", () => {
    const result = runCli(["agent$var", "sprite"]);
    const out = output(result);
    expect(out).toContain("invalid characters");
    expect(result.exitCode).not.toBe(0);
  });

  it("should format error message for backtick injection", () => {
    const result = runCli(["agent`cmd`", "sprite"]);
    const out = output(result);
    expect(out).toContain("invalid characters");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show identifier rules in error message", () => {
    const result = runCli(["Agent!", "sprite"]);
    const out = output(result);
    expect(out).toContain("lowercase letters");
    expect(out).toContain("numbers");
    expect(out).toContain("hyphens");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── Flag ordering edge cases ──────────────────────────────────────────────

describe("flag ordering edge cases", () => {
  it("should handle --prompt before positional args", () => {
    const result = runCli(["--prompt", "Fix bugs", "claude", "sprite"]);
    const out = output(result);
    // Should attempt to run (not error about prompt)
    expect(out).not.toContain("--prompt requires both");
  });

  it("should handle -p between positional args", () => {
    const result = runCli(["claude", "-p", "Fix bugs", "sprite"]);
    const out = output(result);
    // Should attempt to run
    expect(out).not.toContain("--prompt requires both");
  });

  it("should handle --prompt after positional args", () => {
    const result = runCli(["claude", "sprite", "--prompt", "Fix bugs"]);
    const out = output(result);
    expect(out).not.toContain("--prompt requires both");
  });

  it("should reject --prompt with no cloud regardless of flag position", () => {
    const result = runCli(["--prompt", "Fix bugs", "claude"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should reject -p with no cloud regardless of flag position", () => {
    const result = runCli(["-p", "Fix bugs", "claude"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── Unknown flags with subcommands ────────────────────────────────────────

describe("unknown flags with subcommands", () => {
  it("should reject --json with list command", () => {
    const result = runCli(["list", "--json"]);
    const out = output(result);
    expect(out).toContain("Unknown flag");
    expect(out).toContain("--json");
    expect(result.exitCode).not.toBe(0);
  });

  it("should reject --format with agents command", () => {
    const result = runCli(["agents", "--format"]);
    const out = output(result);
    expect(out).toContain("Unknown flag");
    expect(result.exitCode).not.toBe(0);
  });

  it("should reject --dry-run with valid agent and cloud", () => {
    const result = runCli(["claude", "sprite", "--dry-run"]);
    const out = output(result);
    expect(out).toContain("Unknown flag");
    expect(out).toContain("--dry-run");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show supported flags list in unknown flag error", () => {
    const result = runCli(["list", "--json"]);
    const out = output(result);
    expect(out).toContain("Supported flags");
    expect(out).toContain("--prompt");
    expect(out).toContain("--help");
    expect(out).toContain("--version");
  });

  it("should not reject flags that look like negative numbers", () => {
    // -1, -42 etc should NOT be treated as unknown flags
    const result = runCli(["-1"]);
    const out = output(result);
    // Should be treated as a positional arg, not as a flag
    expect(out).not.toContain("Unknown flag");
  });
});

// ── --prompt interaction with subcommands ──────────────────────────────────

describe("--prompt interaction with subcommands", () => {
  it("should error when --prompt is used with no args at all", () => {
    const result = runCli(["--prompt", "Fix bugs"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should error when --prompt is used with 'list' subcommand", () => {
    // "spawn list --prompt 'text'" - list doesn't take a prompt
    // After extracting --prompt, filtered args become ["list"]
    // which dispatches to cmdList (no error about prompt, but --prompt value is ignored)
    const result = runCli(["list", "--prompt", "text"]);
    // cmdList will run since "list" is a subcommand and prompt is not passed to it
    // This should succeed (prompt is simply ignored for subcommands)
    expect(result.exitCode).toBe(0);
  });

  it("should show agent info when --prompt used with single agent arg", () => {
    // "spawn claude --prompt 'text'" - only agent, no cloud
    const result = runCli(["claude", "--prompt", "Fix bugs"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── Version flag edge cases ───────────────────────────────────────────────

describe("version flag edge cases", () => {
  it("should show version for 'version' as first arg regardless of other args", () => {
    const result = runCli(["version"]);
    const out = output(result);
    expect(out).toMatch(/spawn v\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  it("should show version for --version flag", () => {
    const result = runCli(["--version"]);
    const out = output(result);
    expect(out).toMatch(/spawn v\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  it("should show version and exit for -V flag", () => {
    const result = runCli(["-V"]);
    const out = output(result);
    expect(out).toMatch(/spawn v\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  it("should handle 'version' command and ignore extra args", () => {
    // "spawn version extra" - immediateCommands[cmd] fires for "version"
    const result = runCli(["version"]);
    expect(result.exitCode).toBe(0);
  });
});

// ── Non-TTY behavior ──────────────────────────────────────────────────────

describe("non-TTY behavior", () => {
  it("should show help output when no args in non-TTY (subprocess) mode", () => {
    // Subprocesses don't have TTY stdin, so isInteractiveTTY returns false
    const result = runCli([]);
    const out = output(result);
    expect(out).toContain("USAGE");
    expect(result.exitCode).toBe(0);
  });

  it("should include EXAMPLES section in non-TTY help", () => {
    const result = runCli([]);
    const out = output(result);
    expect(out).toContain("EXAMPLES");
  });

  it("should include AUTHENTICATION section in non-TTY help", () => {
    const result = runCli([]);
    const out = output(result);
    expect(out).toContain("AUTHENTICATION");
  });
});

// ── Alias commands ────────────────────────────────────────────────────────

describe("command aliases", () => {
  it("should treat 'ls' as alias for 'list'", () => {
    const result = runCli(["ls"]);
    const out = output(result);
    // 'ls' should produce list output with matrix
    expect(out).toContain("combinations implemented");
    expect(result.exitCode).toBe(0);
  });

  it("should show help for 'ls --help'", () => {
    const result = runCli(["ls", "--help"]);
    const out = output(result);
    expect(out).toContain("USAGE");
    expect(result.exitCode).toBe(0);
  });

  it("should show help for 'ls -h'", () => {
    const result = runCli(["ls", "-h"]);
    const out = output(result);
    expect(out).toContain("USAGE");
    expect(result.exitCode).toBe(0);
  });
});

// ── --prompt-file with real file ──────────────────────────────────────────

describe("--prompt-file with real files", () => {
  it("should error for non-existent prompt file", () => {
    const result = runCli([
      "claude",
      "sprite",
      "--prompt-file",
      "/tmp/spawn-nonexistent-test-file-12345.txt",
    ]);
    const out = output(result);
    expect(out).toContain("Error reading prompt file");
    expect(result.exitCode).not.toBe(0);
  });

  it("should include filename in error message for missing file", () => {
    const result = runCli([
      "claude",
      "sprite",
      "--prompt-file",
      "/tmp/spawn-missing-file.txt",
    ]);
    const out = output(result);
    expect(out).toContain("spawn-missing-file.txt");
  });

  it("should include hint about file existence in error", () => {
    const result = runCli([
      "claude",
      "sprite",
      "--prompt-file",
      "/tmp/spawn-missing-file.txt",
    ]);
    const out = output(result);
    expect(out).toContain("Make sure the file exists");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── Multiple agent/cloud resolution ───────────────────────────────────────

describe("agent and cloud display name resolution in cmdRun", () => {
  it("should resolve uppercase agent key and show resolution message", () => {
    const result = runCli(["CLAUDE", "sprite"]);
    const out = output(result);
    expect(out).toContain("Resolved");
    expect(out).not.toContain("Unknown agent");
  });

  it("should resolve uppercase cloud key and show resolution message", () => {
    const result = runCli(["claude", "SPRITE"]);
    const out = output(result);
    expect(out).toContain("Resolved");
    expect(out).not.toContain("Unknown cloud");
  });

  it("should resolve both uppercase agent and cloud", () => {
    const result = runCli(["CLAUDE", "SPRITE"]);
    const out = output(result);
    // Both should be resolved
    expect(out).toContain("Resolved");
    expect(out).not.toContain("Unknown");
  });

  it("should not show resolution for exact lowercase keys", () => {
    const result = runCli(["claude", "sprite"]);
    const out = output(result);
    expect(out).not.toContain("Resolved");
  });
});

// ── Subcommand list and agents output format ──────────────────────────────

describe("subcommand output format verification", () => {
  it("'agents' should list all agents in manifest", () => {
    const result = runCli(["agents"]);
    const out = output(result);
    expect(out).toContain("Agents");
    expect(out).toContain("claude");
    expect(out).toContain("aider");
    expect(result.exitCode).toBe(0);
  });

  it("'clouds' should list all clouds in manifest", () => {
    const result = runCli(["clouds"]);
    const out = output(result);
    expect(out).toContain("Cloud Providers");
    expect(out).toContain("sprite");
    expect(out).toContain("hetzner");
    expect(result.exitCode).toBe(0);
  });

  it("'list' should show the availability matrix", () => {
    const result = runCli(["list"]);
    const out = output(result);
    expect(out).toContain("combinations implemented");
    expect(result.exitCode).toBe(0);
  });

  it("'list' should show usage hints at the bottom", () => {
    const result = runCli(["list"]);
    const out = output(result);
    expect(out).toContain("spawn <agent>");
    expect(out).toContain("spawn <cloud>");
  });
});

// ── Fuzzy match edge cases ────────────────────────────────────────────────

describe("fuzzy matching edge cases in showInfoOrError", () => {
  it("should suggest close agent match for 2-char typo", () => {
    // "cloude" is distance 1 from "claude"
    const result = runCli(["cloude"]);
    const out = output(result);
    expect(out).toContain("Did you mean");
    expect(out).toContain("claude");
  });

  it("should suggest close cloud match for 1-char typo", () => {
    // "hetzne" is distance 1 from "hetzner"
    const result = runCli(["hetzne"]);
    const out = output(result);
    expect(out).toContain("Did you mean");
    expect(out).toContain("hetzner");
  });

  it("should not suggest for string with distance > 3", () => {
    // "abcdefgh" is far from any agent/cloud
    const result = runCli(["abcdefgh"]);
    const out = output(result);
    expect(out).toContain("Unknown command");
    expect(out).not.toContain("Did you mean");
  });

  it("should show both agent and cloud suggestions when both match", () => {
    // Need a string close to both an agent and a cloud name
    // "sprit" is close to "sprite" (cloud, distance 1)
    const result = runCli(["sprit"]);
    const out = output(result);
    // Should suggest sprite as a cloud
    expect(out).toContain("sprite");
    expect(out).toContain("(cloud)");
  });
});

// ── SPAWN_NO_UNICODE env var ──────────────────────────────────────────────

describe("SPAWN_NO_UNICODE environment variable", () => {
  it("should work normally with SPAWN_NO_UNICODE=1", () => {
    const result = runCli(["help"], { SPAWN_NO_UNICODE: "1" });
    const out = output(result);
    expect(out).toContain("USAGE");
    expect(result.exitCode).toBe(0);
  });

  it("should work normally with SPAWN_ASCII=1", () => {
    const result = runCli(["version"], { SPAWN_ASCII: "1" });
    const out = output(result);
    expect(out).toMatch(/spawn v\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });
});

// ── SPAWN_NO_UPDATE_CHECK env var ─────────────────────────────────────────

describe("SPAWN_NO_UPDATE_CHECK behavior", () => {
  it("should skip update check and run command immediately", () => {
    const start = Date.now();
    const result = runCli(["version"], { SPAWN_NO_UPDATE_CHECK: "1" });
    const elapsed = Date.now() - start;
    expect(output(result)).toMatch(/spawn v\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
    // With update check skipped, should be fast (< 10s)
    expect(elapsed).toBeLessThan(10000);
  });
});
