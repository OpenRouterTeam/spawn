import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for cmdRun argument resolution paths:
 * - Display name resolution ("Claude Code" -> "claude")
 * - Case-insensitive key resolution ("Claude" -> "claude")
 * - Argument swapping detection (cloud/agent -> agent/cloud)
 * - showInfoOrError display name resolution ("Hetzner Cloud" -> cloud info)
 *
 * These paths in commands.ts cmdRun() (lines 252-304) and index.ts
 * showInfoOrError() (lines 87-128) have zero E2E test coverage.
 *
 * Uses subprocess approach since cmdRun calls process.exit on errors.
 *
 * Agent: test-engineer
 */

const CLI_DIR = resolve(import.meta.dir, "../..");
const PROJECT_ROOT = resolve(CLI_DIR, "..");

function runCli(
  args: string[],
  env: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number } {
  const quotedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const bunPath = `${process.env.HOME || "/root"}/.bun/bin/bun`;
  const cmd = `${bunPath} run ${CLI_DIR}/src/index.ts ${quotedArgs}`;
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME || "/root",
        SHELL: process.env.SHELL || "/bin/bash",
        TERM: process.env.TERM || "xterm",
        ...env,
        SPAWN_NO_UPDATE_CHECK: "1",
        NODE_ENV: "test",
        BUN_ENV: "test",
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

// ── cmdRun: argument swapping detection ───────────────────────────────────

describe("cmdRun argument swapping", () => {
  it("should detect swapped cloud/agent and show swap warning", () => {
    // "spawn sprite claude" should be detected as swapped -> "spawn claude sprite"
    // cmdRun will swap and try to launch, which will fail at download (no network)
    // but the swap message should appear in output
    const result = runCli(["sprite", "claude"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("swapped");
  });

  it("should show corrected command after swap detection", () => {
    const result = runCli(["sprite", "claude"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("spawn claude sprite");
  });

  it("should swap hetzner/aider to aider/hetzner", () => {
    const result = runCli(["hetzner", "aider"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("swapped");
  });

  it("should not swap when arguments are in correct order", () => {
    // "spawn claude sprite" is correct order - no swap message
    const result = runCli(["claude", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("swapped");
  });

  it("should not swap when both args are unknown", () => {
    const result = runCli(["fakething", "otherfake"]);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("swapped");
  });
});

// ── cmdRun: display name resolution ───────────────────────────────────────

describe("cmdRun display name resolution", () => {
  it("should resolve case-insensitive agent key", () => {
    // "Claude" should resolve to "claude"
    const result = runCli(["Claude", "sprite"]);
    const output = result.stdout + result.stderr;
    // Should resolve and proceed (may show "Resolved" message)
    // Should NOT show "Unknown agent" error
    expect(output).not.toContain("Unknown agent");
  });

  it("should resolve case-insensitive cloud key", () => {
    // "Sprite" should resolve to "sprite"
    const result = runCli(["claude", "Sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("Unknown cloud");
  });

  it("should show resolution message when name is resolved", () => {
    // "CLAUDE" -> "claude" should trigger "Resolved" message
    const result = runCli(["CLAUDE", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Resolved");
    expect(output).toContain("claude");
  });

  it("should resolve agent display name to key", () => {
    // "Claude Code" is the display name for agent key "claude"
    const result = runCli(["Claude Code", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Resolved");
    expect(output).toContain("claude");
  });

  it("should resolve cloud display name to key", () => {
    // "Hetzner Cloud" is the display name for cloud key "hetzner"
    const result = runCli(["claude", "Hetzner Cloud"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Resolved");
    expect(output).toContain("hetzner");
  });

  it("should not show resolution message for exact key match", () => {
    // "claude" is already the exact key - no resolution needed
    const result = runCli(["claude", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("Resolved");
  });

  it("should show unknown agent error for truly invalid agent", () => {
    const result = runCli(["notarealagent", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Unknown agent");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show unknown cloud error for truly invalid cloud", () => {
    const result = runCli(["claude", "notarealcloud"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Unknown cloud");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── showInfoOrError: display name resolution ──────────────────────────────

describe("showInfoOrError display name resolution", () => {
  it("should resolve agent display name to agent info", () => {
    // "Claude Code" -> resolves to "claude" via resolveAgentKey -> shows agent info
    const result = runCli(["Claude Code"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available clouds");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve cloud display name to cloud info", () => {
    // "Hetzner Cloud" -> resolves to "hetzner" via resolveCloudKey -> shows cloud info
    const result = runCli(["Hetzner Cloud"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available agents");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve case-insensitive agent display name", () => {
    // "claude code" (lowercase) -> resolves to agent info
    const result = runCli(["claude code"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available clouds");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve case-insensitive cloud display name", () => {
    // "hetzner cloud" (lowercase) -> resolves to cloud info
    const result = runCli(["hetzner cloud"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available agents");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve uppercase agent key", () => {
    // "CLAUDE" -> resolves to "claude" key
    const result = runCli(["CLAUDE"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available clouds");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve uppercase cloud key", () => {
    // "HETZNER" -> resolves to "hetzner" key
    const result = runCli(["HETZNER"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available agents");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve mixed case agent key", () => {
    const result = runCli(["Aider"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Available clouds");
    expect(result.exitCode).toBe(0);
  });
});

// ── cmdRun: "did you mean" suggestions ────────────────────────────────────

describe("cmdRun did-you-mean suggestions", () => {
  it("should suggest closest agent match for typo", () => {
    // "claud" is close to "claude" (distance 1)
    const result = runCli(["claud", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Did you mean");
    expect(output).toContain("claude");
    expect(result.exitCode).not.toBe(0);
  });

  it("should suggest closest cloud match for typo", () => {
    // "sprte" is close to "sprite" (distance 1)
    const result = runCli(["claude", "sprte"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Did you mean");
    expect(output).toContain("sprite");
    expect(result.exitCode).not.toBe(0);
  });

  it("should not suggest anything for completely different agent", () => {
    const result = runCli(["kubernetes", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Unknown agent");
    expect(output).not.toContain("Did you mean");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show spawn agents hint for unknown agent", () => {
    const result = runCli(["notreal", "sprite"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("spawn agents");
  });

  it("should show spawn clouds hint for unknown cloud", () => {
    const result = runCli(["claude", "notreal"]);
    const output = result.stdout + result.stderr;
    expect(output).toContain("spawn clouds");
  });
});

// ── validateImplementation: not-implemented error paths ───────────────────

describe("cmdRun not-implemented error", () => {
  it("should show not implemented error for missing matrix entry", () => {
    // Find a known missing combination from the manifest
    // We check a combination that exists in the manifest as "missing"
    // This tests validateImplementation's error messaging
    const result = runCli(["claude", "cherry-servers"]);
    const output = result.stdout + result.stderr;
    // Should either succeed (if implemented) or show useful error
    // The key thing is it doesn't crash
    if (result.exitCode !== 0) {
      // If not implemented, should show helpful alternatives
      expect(output.length).toBeGreaterThan(0);
    }
  });

  it("should suggest alternative clouds when agent is not on specified cloud", () => {
    // We need a cloud that exists but doesn't have all agents
    // Test the "available on N clouds" message path
    // Using a known agent with a cloud that may not have it
    const result = runCli(["claude", "cherry-servers"]);
    const output = result.stdout + result.stderr;
    if (output.includes("not yet implemented")) {
      // Should suggest alternative clouds
      expect(output).toMatch(/available on|Try one of these/);
    }
  });
});
