import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for showInfoOrError in index.ts (lines 85-110).
 *
 * This function has zero direct test coverage. It handles the single-argument
 * case where a user types "spawn <name>" and the name could be:
 * - A valid agent key -> shows agent info (cmdAgentInfo)
 * - A valid cloud key -> shows cloud info (cmdCloudInfo)
 * - An unknown name -> shows "Unknown agent or cloud" with fuzzy suggestions
 *
 * Since showInfoOrError is not exported and calls loadManifest + process.exit,
 * we test it by spawning bun subprocesses (same approach as index-main-routing.test.ts).
 *
 * These tests use the local manifest.json by explicitly unsetting NODE_ENV/BUN_ENV
 * in the subprocess environment so that loadManifest reads the project manifest.
 *
 * Agent: test-engineer
 */

const CLI_DIR = resolve(import.meta.dir, "../..");

// Use the project root (which has manifest.json) as cwd
const PROJECT_ROOT = resolve(CLI_DIR, "..");

function runCli(
  args: string[],
  env: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number } {
  // Quote each arg to handle spaces properly
  const quotedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `bun run ${CLI_DIR}/src/index.ts ${quotedArgs}`;
  const bunPath = resolve(process.env.HOME || "", ".bun", "bin");
  const currentPath = process.env.PATH || "";
  const fullPath = currentPath
    ? `${bunPath}:${currentPath}`
    : bunPath;
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_ROOT,
      env: {
        // Start with clean env to avoid bun test's NODE_ENV=test leaking
        PATH: fullPath,
        HOME: process.env.HOME,
        SHELL: process.env.SHELL,
        TERM: process.env.TERM || "xterm",
        ...env,
        SPAWN_NO_UPDATE_CHECK: "1",
        // Explicitly unset test env vars so local manifest.json is loaded
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

describe("showInfoOrError - single argument routing", () => {
  // ── Valid agent name: shows agent info ──────────────────────────────────

  describe("valid agent name shows agent info", () => {
    it("should show agent info for 'claude'", () => {
      const result = runCli(["claude"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Available clouds");
      expect(result.exitCode).toBe(0);
    });

    it("should show agent info for 'aider'", () => {
      const result = runCli(["aider"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Available clouds");
      expect(result.exitCode).toBe(0);
    });

    it("should show launch commands in agent info", () => {
      const result = runCli(["claude"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("spawn claude");
    });

    it("should show agent description", () => {
      const result = runCli(["claude"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Claude Code");
    });
  });

  // ── Valid cloud name: shows cloud info ─────────────────────────────────

  describe("valid cloud name shows cloud info", () => {
    it("should show cloud info for 'hetzner'", () => {
      const result = runCli(["hetzner"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Available agents");
      expect(result.exitCode).toBe(0);
    });

    it("should show cloud info for 'sprite'", () => {
      const result = runCli(["sprite"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Available agents");
      expect(result.exitCode).toBe(0);
    });

    it("should show cloud type in cloud info", () => {
      const result = runCli(["hetzner"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Type:");
    });

    it("should show cloud description", () => {
      const result = runCli(["hetzner"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Hetzner");
    });
  });

  // ── Unknown agent or cloud: error output ──────────────────────────────────────

  describe("unknown single argument", () => {
    it("should show 'Unknown agent or cloud' for an unrecognized name", () => {
      const result = runCli(["xyzzyplugh"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Unknown agent or cloud");
      expect(result.exitCode).not.toBe(0);
    });

    it("should include the unknown name in the error", () => {
      const result = runCli(["xyzzyplugh"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("xyzzyplugh");
    });

    it("should suggest 'spawn agents' in error output", () => {
      const result = runCli(["xyzzyplugh"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("spawn agents");
    });

    it("should suggest 'spawn clouds' in error output", () => {
      const result = runCli(["xyzzyplugh"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("spawn clouds");
    });

    it("should suggest 'spawn help' in error output", () => {
      const result = runCli(["xyzzyplugh"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("spawn help");
    });

    it("should exit with non-zero for unknown command", () => {
      const result = runCli(["totallyunknown"]);
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ── Fuzzy matching suggestions ─────────────────────────────────────────

  describe("fuzzy match suggestions", () => {
    it("should suggest a close agent match for a typo", () => {
      // "aidr" is close to "aider" (distance 1)
      const result = runCli(["aidr"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Did you mean");
      expect(output).toContain("aider");
    });

    it("should suggest a close cloud match for a typo", () => {
      // "sprte" is close to "sprite" (distance 1)
      const result = runCli(["sprte"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Did you mean");
      expect(output).toContain("sprite");
    });

    it("should NOT suggest a match for a completely different string", () => {
      // "kubernetes" is far from any agent or cloud name
      const result = runCli(["kubernetes"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Unknown agent or cloud");
      expect(output).not.toContain("Did you mean");
    });

    it("should label the suggestion type (agent or cloud)", () => {
      // "aidr" should match "aider" (an agent)
      const result = runCli(["aidr"]);
      const output = result.stdout + result.stderr;
      // showInfoOrError labels suggestions as "(agent: Name)" or "(cloud: Name)"
      expect(output).toMatch(/\(agent:|\(cloud:/);
    });
  });

  // ── handleDefaultCommand help flag routing ─────────────────────────────

  describe("agent with help flag", () => {
    it("should show agent info when agent followed by --help", () => {
      const result = runCli(["claude", "--help"]);
      const output = result.stdout + result.stderr;
      // handleDefaultCommand routes "spawn claude --help" to showInfoOrError
      expect(output).toContain("Available clouds");
      expect(result.exitCode).toBe(0);
    });

    it("should show agent info when agent followed by -h", () => {
      const result = runCli(["claude", "-h"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Available clouds");
      expect(result.exitCode).toBe(0);
    });

    it("should show agent info when agent followed by 'help'", () => {
      const result = runCli(["claude", "help"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Available clouds");
      expect(result.exitCode).toBe(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should not treat numeric-only input as a valid agent or cloud", () => {
      const result = runCli(["12345"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Unknown agent or cloud");
      expect(result.exitCode).not.toBe(0);
    });

    it("should handle hyphenated names that are not real entries", () => {
      const result = runCli(["not-a-real-entry"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("Unknown agent or cloud");
      expect(result.exitCode).not.toBe(0);
    });

    it("should error when --prompt is given with agent but no cloud", () => {
      const result = runCli(["claude", "--prompt", "Fix bugs"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("--prompt requires both");
      expect(result.exitCode).not.toBe(0);
    });

    it("should include usage hint in prompt-without-cloud error", () => {
      const result = runCli(["claude", "--prompt", "Fix bugs"]);
      const output = result.stdout + result.stderr;
      expect(output).toContain("spawn claude");
      expect(output).toContain("<cloud>");
    });
  });
});
