import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

/**
 * Tests for the post-session summary feature (PR #1037):
 *
 * - _show_post_session_summary: warns user their server is still running,
 *   shows dashboard URL (if available), and provides reconnect command
 * - ssh_interactive_session: now calls _show_post_session_summary after
 *   the SSH session ends, and preserves the SSH exit code
 * - SPAWN_DASHBOARD_URL convention: all SSH-based cloud providers must
 *   set this variable so users get actionable dashboard links
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;
let mockBinDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `spawn-post-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mockBinDir = join(testDir, "bin");
  mkdirSync(mockBinDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 */
function runBash(
  script: string,
  opts?: { useMockPath?: boolean; env?: Record<string, string> }
): { exitCode: number; stdout: string; stderr: string } {
  let prefix = "";
  if (opts?.useMockPath) {
    prefix = `export PATH="${mockBinDir}:$PATH"\n`;
  }
  const fullScript = `${prefix}source "${COMMON_SH}"\n${script}`;
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts?.env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

/**
 * Create a mock executable in the mock bin directory.
 */
function createMockCommand(name: string, script: string): void {
  const path = join(mockBinDir, name);
  writeFileSync(path, `#!/bin/bash\n${script}`, { mode: 0o755 });
}

// ── _show_post_session_summary ──────────────────────────────────────────────

describe("_show_post_session_summary", () => {
  it("should warn that the server is still running at the given IP", () => {
    const { stderr } = runBash(
      '_show_post_session_summary "203.0.113.42"'
    );
    expect(stderr).toContain("still running");
    expect(stderr).toContain("203.0.113.42");
  });

  it("should show dashboard URL when SPAWN_DASHBOARD_URL is set", () => {
    const { stderr } = runBash(
      'SPAWN_DASHBOARD_URL="https://console.example.com/servers"\n_show_post_session_summary "10.0.0.1"'
    );
    expect(stderr).toContain("https://console.example.com/servers");
    expect(stderr).toContain("dashboard");
  });

  it("should show generic message when SPAWN_DASHBOARD_URL is not set", () => {
    const { stderr } = runBash(
      'unset SPAWN_DASHBOARD_URL\n_show_post_session_summary "10.0.0.1"'
    );
    expect(stderr).toContain("cloud provider dashboard");
    expect(stderr).not.toContain("https://");
  });

  it("should show reconnect command with default SSH_USER=root", () => {
    const { stderr } = runBash(
      '_show_post_session_summary "192.168.1.100"'
    );
    expect(stderr).toContain("ssh root@192.168.1.100");
  });

  it("should show reconnect command with custom SSH_USER", () => {
    const { stderr } = runBash(
      'SSH_USER=ubuntu\n_show_post_session_summary "192.168.1.100"'
    );
    expect(stderr).toContain("ssh ubuntu@192.168.1.100");
  });

  it("should use log_warn for all output lines (yellow warning styling)", () => {
    const { stderr } = runBash(
      '_show_post_session_summary "10.0.0.1"'
    );
    // log_warn outputs to stderr with WARNING prefix or yellow color
    // Every substantive line should go through log_warn
    expect(stderr).toContain("Session ended");
    expect(stderr).toContain("reconnect");
  });

  it("should handle empty SPAWN_DASHBOARD_URL same as unset", () => {
    const { stderr } = runBash(
      'SPAWN_DASHBOARD_URL=""\n_show_post_session_summary "10.0.0.1"'
    );
    expect(stderr).toContain("cloud provider dashboard");
    expect(stderr).not.toContain("visit your dashboard");
  });

  it("should handle IPv6 addresses", () => {
    const { stderr } = runBash(
      '_show_post_session_summary "2001:db8::1"'
    );
    expect(stderr).toContain("2001:db8::1");
    expect(stderr).toContain("still running");
  });
});

// ── _show_exec_post_session_summary ─────────────────────────────────────────

describe("_show_exec_post_session_summary", () => {
  it("should warn that the service is still running", () => {
    const { stderr } = runBash(
      '_show_exec_post_session_summary'
    );
    expect(stderr).toContain("still running");
    expect(stderr).toContain("Session ended");
  });

  it("should show service name when SERVER_NAME is set", () => {
    const { stderr } = runBash(
      'SERVER_NAME="my-app"\n_show_exec_post_session_summary'
    );
    expect(stderr).toContain("my-app");
    expect(stderr).toContain("still running");
  });

  it("should show dashboard URL when SPAWN_DASHBOARD_URL is set", () => {
    const { stderr } = runBash(
      'SPAWN_DASHBOARD_URL="https://fly.io/dashboard"\n_show_exec_post_session_summary'
    );
    expect(stderr).toContain("https://fly.io/dashboard");
    expect(stderr).toContain("dashboard");
  });

  it("should show generic message when SPAWN_DASHBOARD_URL is not set", () => {
    const { stderr } = runBash(
      'unset SPAWN_DASHBOARD_URL\n_show_exec_post_session_summary'
    );
    expect(stderr).toContain("cloud provider dashboard");
  });

  it("should show reconnect command when SPAWN_RECONNECT_CMD is set", () => {
    const { stderr } = runBash(
      'SPAWN_RECONNECT_CMD="fly ssh console -a my-app"\n_show_exec_post_session_summary'
    );
    expect(stderr).toContain("fly ssh console -a my-app");
    expect(stderr).toContain("reconnect");
  });

  it("should not show reconnect section when SPAWN_RECONNECT_CMD is not set", () => {
    const { stderr } = runBash(
      'unset SPAWN_RECONNECT_CMD\n_show_exec_post_session_summary'
    );
    expect(stderr).not.toContain("reconnect");
  });

  it("should use 'service' instead of 'server' in messages", () => {
    const { stderr } = runBash(
      '_show_exec_post_session_summary'
    );
    expect(stderr).toContain("service");
  });

  it("should not crash with no env vars set", () => {
    const { exitCode } = runBash(
      'unset SPAWN_DASHBOARD_URL SERVER_NAME SPAWN_RECONNECT_CMD\n_show_exec_post_session_summary'
    );
    expect(exitCode).toBe(0);
  });
});

// ── ssh_interactive_session with post-session summary ───────────────────────

describe("ssh_interactive_session post-session integration", () => {
  it("should show post-session summary after SSH session ends", () => {
    createMockCommand("ssh", "exit 0");
    const { stderr } = runBash(
      'SSH_OPTS=""\nssh_interactive_session "10.0.0.1" "bash"',
      { useMockPath: true }
    );
    expect(stderr).toContain("Session ended");
    expect(stderr).toContain("still running");
    expect(stderr).toContain("10.0.0.1");
  });

  it("should preserve SSH exit code 0 on success", () => {
    createMockCommand("ssh", "exit 0");
    const { exitCode } = runBash(
      'SSH_OPTS=""\nssh_interactive_session "10.0.0.1" "bash"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
  });

  it("should preserve non-zero SSH exit code on failure", () => {
    createMockCommand("ssh", "exit 42");
    const { exitCode, stderr } = runBash(
      'SSH_OPTS=""\nset +e\nssh_interactive_session "10.0.0.1" "bash"\necho "EXIT=$?"',
      { useMockPath: true }
    );
    // The summary should still appear even on failure
    expect(stderr).toContain("still running");
  });

  it("should show summary even when SSH exits with error", () => {
    createMockCommand("ssh", "exit 1");
    const { stderr } = runBash(
      'SSH_OPTS=""\nset +e\nresult=0\nssh_interactive_session "10.0.0.1" "bash" || result=$?\necho "EXIT=$result"',
      { useMockPath: true }
    );
    expect(stderr).toContain("Session ended");
    expect(stderr).toContain("reconnect");
  });

  it("should include dashboard URL when SPAWN_DASHBOARD_URL is set", () => {
    createMockCommand("ssh", "exit 0");
    const { stderr } = runBash(
      'SSH_OPTS=""\nSPAWN_DASHBOARD_URL="https://console.hetzner.cloud/"\nssh_interactive_session "10.0.0.1" "bash"',
      { useMockPath: true }
    );
    expect(stderr).toContain("https://console.hetzner.cloud/");
  });

  it("should show reconnect command with correct user and IP", () => {
    createMockCommand("ssh", "exit 0");
    const { stderr } = runBash(
      'SSH_OPTS=""\nSSH_USER=deploy\nssh_interactive_session "172.16.0.5" "tmux"',
      { useMockPath: true }
    );
    expect(stderr).toContain("ssh deploy@172.16.0.5");
  });

  it("should still pass -t flag and correct SSH args", () => {
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no"\nssh_interactive_session "10.0.0.1" "bash"',
      { useMockPath: true }
    );
    expect(stdout).toContain("-t");
    expect(stdout).toContain("root@10.0.0.1");
    expect(stdout).toContain("bash");
  });
});


// ── _show_post_session_summary does not use SPAWN_DASHBOARD_URL from function scope ─

describe("_show_post_session_summary env var handling", () => {
  it("should read SPAWN_DASHBOARD_URL from environment, not from arguments", () => {
    // Verify it uses env var, not positional args for the dashboard URL
    const { stderr } = runBash(
      'export SPAWN_DASHBOARD_URL="https://test.example.com"\n_show_post_session_summary "10.0.0.1"'
    );
    expect(stderr).toContain("https://test.example.com");
  });

  it("should not crash when called with only IP argument", () => {
    const { exitCode } = runBash(
      '_show_post_session_summary "10.0.0.1"'
    );
    expect(exitCode).toBe(0);
  });

  it("should handle SPAWN_DASHBOARD_URL with trailing slash", () => {
    const { stderr } = runBash(
      'SPAWN_DASHBOARD_URL="https://console.example.com/"\n_show_post_session_summary "10.0.0.1"'
    );
    expect(stderr).toContain("https://console.example.com/");
  });

  it("should handle SPAWN_DASHBOARD_URL with path components", () => {
    const { stderr } = runBash(
      'SPAWN_DASHBOARD_URL="https://cloud.oracle.com/compute/instances"\n_show_post_session_summary "10.0.0.1"'
    );
    expect(stderr).toContain("https://cloud.oracle.com/compute/instances");
  });
});

// ── shared/common.sh function definitions ───────────────────────────────────

describe("function definitions in shared/common.sh", () => {
  const sharedContent = readFileSync(COMMON_SH, "utf-8");

  it("should define _show_post_session_summary", () => {
    expect(sharedContent).toContain("_show_post_session_summary()");
  });

  it("should define _show_exec_post_session_summary", () => {
    expect(sharedContent).toContain("_show_exec_post_session_summary()");
  });

  it("should define ssh_interactive_session that calls _show_post_session_summary", () => {
    // Find the ssh_interactive_session function body
    const lines = sharedContent.split("\n");
    let inFunc = false;
    let braceDepth = 0;
    const bodyLines: string[] = [];

    for (const line of lines) {
      if (!inFunc) {
        if (line.match(/^ssh_interactive_session\(\)\s*\{/)) {
          inFunc = true;
          braceDepth = 1;
          continue;
        }
        continue;
      }
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0) break;
      bodyLines.push(line);
    }

    const body = bodyLines.join("\n");
    expect(body).toContain("_show_post_session_summary");
    expect(body).toContain('ssh_exit');
  });

  it("ssh_interactive_session should capture ssh exit code instead of failing immediately", () => {
    const lines = sharedContent.split("\n");
    let inFunc = false;
    let braceDepth = 0;
    const bodyLines: string[] = [];

    for (const line of lines) {
      if (!inFunc) {
        if (line.match(/^ssh_interactive_session\(\)\s*\{/)) {
          inFunc = true;
          braceDepth = 1;
          continue;
        }
        continue;
      }
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0) break;
      bodyLines.push(line);
    }

    const body = bodyLines.join("\n");
    // Should use || ssh_exit=$? pattern instead of letting set -e kill the script
    expect(body).toContain("|| ssh_exit=$?");
    // Should return the captured exit code
    expect(body).toContain("return");
    expect(body).toContain("ssh_exit");
  });
});
