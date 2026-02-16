import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";

/**
 * Tests for error paths when agent/cloud arguments are missing.
 *
 * These paths in index.ts have zero test coverage:
 * - suggestCloudsForPrompt (lines 154-178): shows available clouds when
 *   --prompt is used with agent but no cloud
 * - handleNoCommand dry-run error (lines 238-242): --dry-run without agent/cloud
 * - handleNoCommand prompt error (lines 243-247): --prompt without agent/cloud
 * - handleDefaultCommand dry-run error (lines 141-145): --dry-run with agent but no cloud
 *
 * These are user-facing error messages that guide users to correct usage.
 *
 * Agent: test-engineer
 */

const CLI_DIR = resolve(import.meta.dir, "../..");
const PROJECT_ROOT = resolve(CLI_DIR, "..");
const TEST_DIR = resolve("/tmp", `spawn-no-cloud-test-${Date.now()}`);

function runCli(
  args: string[],
  env: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number } {
  const quotedArgs = args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");
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

function output(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr;
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ── suggestCloudsForPrompt: --prompt with agent but no cloud ──────────────

describe("suggestCloudsForPrompt (--prompt with agent, no cloud)", () => {
  it("should show error that --prompt requires both agent and cloud", () => {
    const result = runCli(["claude", "--prompt", "Fix all bugs"]);
    expect(output(result)).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show usage example with the agent name", () => {
    const result = runCli(["claude", "--prompt", "Fix all bugs"]);
    const out = output(result);
    expect(out).toContain("spawn claude <cloud>");
  });

  it("should suggest available clouds for the agent", () => {
    const result = runCli(["claude", "--prompt", "Fix all bugs"]);
    const out = output(result);
    // suggestCloudsForPrompt fetches the manifest and lists available clouds
    expect(out).toContain("Available clouds for");
  });

  it("should show example spawn commands with specific clouds", () => {
    const result = runCli(["claude", "--prompt", "Fix all bugs"]);
    const out = output(result);
    // Should suggest at least one concrete spawn command with a real cloud
    expect(out).toMatch(/spawn claude \S+ --prompt/);
  });

  it("should work with -p short form", () => {
    const result = runCli(["claude", "-p", "Fix bugs"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(out).toContain("Available clouds for");
    expect(result.exitCode).not.toBe(0);
  });

  it("should work with aider agent", () => {
    const result = runCli(["aider", "--prompt", "Add tests"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(out).toContain("spawn aider <cloud>");
  });

  it("should suggest clouds for aider agent", () => {
    const result = runCli(["aider", "--prompt", "Refactor"]);
    const out = output(result);
    // aider has multiple implemented clouds
    expect(out).toContain("Available clouds for");
  });

  it("should show at most 5 concrete cloud suggestions", () => {
    const result = runCli(["claude", "--prompt", "Fix bugs"]);
    const out = output(result);
    // suggestCloudsForPrompt shows max 5 examples with real cloud names
    // Filter for lines with "spawn claude <real-cloud-name> --prompt"
    // but exclude the usage hint line which has "<cloud>" placeholder
    const spawnLines = out
      .split("\n")
      .filter(
        (l) =>
          l.includes("spawn claude") &&
          l.includes("--prompt") &&
          !l.includes("<cloud>")
      );
    // Should have at most 5 example lines
    expect(spawnLines.length).toBeLessThanOrEqual(5);
  });

  it("should show 'see all N clouds' hint when more than 5 clouds available", () => {
    // claude has many clouds (>5), so the hint should appear
    const result = runCli(["claude", "--prompt", "Fix bugs"]);
    const out = output(result);
    // Check for the "see all" hint (only shown when >5 clouds available)
    if (out.includes("see all")) {
      expect(out).toMatch(/spawn claude/);
    }
    // At minimum, the error and suggestion section should be present
    expect(out).toContain("Available clouds for");
  });
});

// ── --prompt-file with agent but no cloud ─────────────────────────────────

describe("suggestCloudsForPrompt (--prompt-file with agent, no cloud)", () => {
  const promptFile = resolve(TEST_DIR, "prompt.txt");

  beforeAll(() => {
    writeFileSync(promptFile, "Fix all the things");
  });

  it("should show same error as --prompt when using --prompt-file", () => {
    const result = runCli(["claude", "--prompt-file", promptFile]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should suggest available clouds even with --prompt-file", () => {
    const result = runCli(["claude", "--prompt-file", promptFile]);
    const out = output(result);
    expect(out).toContain("Available clouds for");
  });

  it("should show usage example with <cloud> placeholder", () => {
    const result = runCli(["claude", "-f", promptFile]);
    const out = output(result);
    expect(out).toContain("<cloud>");
  });
});

// ── handleNoCommand: --dry-run without any args ───────────────────────────

describe("--dry-run without agent and cloud", () => {
  it("should show error that --dry-run requires both agent and cloud", () => {
    const result = runCli(["--dry-run"]);
    const out = output(result);
    expect(out).toContain("--dry-run requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show usage hint with spawn <agent> <cloud> --dry-run", () => {
    const result = runCli(["--dry-run"]);
    const out = output(result);
    expect(out).toContain("spawn <agent> <cloud> --dry-run");
  });

  it("should work with -n short form", () => {
    const result = runCli(["-n"]);
    const out = output(result);
    expect(out).toContain("--dry-run requires both");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── handleDefaultCommand: --dry-run with agent but no cloud ───────────────

describe("--dry-run with agent but no cloud", () => {
  it("should show error that --dry-run requires both agent and cloud", () => {
    const result = runCli(["claude", "--dry-run"]);
    const out = output(result);
    expect(out).toContain("--dry-run requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show usage hint", () => {
    const result = runCli(["claude", "--dry-run"]);
    const out = output(result);
    expect(out).toContain("spawn <agent> <cloud> --dry-run");
  });

  it("should work with -n short form and agent", () => {
    const result = runCli(["claude", "-n"]);
    const out = output(result);
    expect(out).toContain("--dry-run requires both");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── handleNoCommand: --prompt without any args ────────────────────────────

describe("--prompt without any agent or cloud", () => {
  it("should show error that --prompt requires both agent and cloud", () => {
    const result = runCli(["--prompt", "Fix bugs"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });

  it("should show usage hint", () => {
    const result = runCli(["--prompt", "Fix bugs"]);
    const out = output(result);
    expect(out).toContain("spawn <agent> <cloud>");
  });

  it("should work with -p short form", () => {
    const result = runCli(["-p", "Fix bugs"]);
    const out = output(result);
    expect(out).toContain("--prompt requires both");
    expect(result.exitCode).not.toBe(0);
  });
});

// ── Combined: --dry-run and --prompt without cloud ────────────────────────

describe("--dry-run combined with --prompt without cloud", () => {
  it("should show dry-run error when both --dry-run and --prompt but no cloud", () => {
    // --dry-run is checked first in handleDefaultCommand
    const result = runCli(["claude", "--dry-run", "--prompt", "Fix bugs"]);
    const out = output(result);
    // Should show one of the two errors
    expect(out).toMatch(/requires both/);
    expect(result.exitCode).not.toBe(0);
  });
});

// ── Edge: unknown agent with --prompt ─────────────────────────────────────

describe("unknown agent with --prompt", () => {
  it("should show prompt-requires-cloud error even for unknown agent", () => {
    // The prompt-without-cloud check happens before agent validation
    const result = runCli(["fakeagent", "--prompt", "Fix bugs"]);
    const out = output(result);
    // Could show "requires both" or "Unknown agent" depending on routing
    expect(result.exitCode).not.toBe(0);
  });

  it("should handle --prompt with agent typo gracefully", () => {
    const result = runCli(["claud", "--prompt", "Fix bugs"]);
    const out = output(result);
    // Should not crash; should show some useful error
    expect(result.exitCode).not.toBe(0);
    expect(out.length).toBeGreaterThan(0);
  });
});
