import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for shared/common.sh helper functions:
 *
 * - log_install_failed: Actionable error guidance for agent installation failures
 * - ensure_jq: Cross-platform jq installation
 * - verify_agent_installed: Agent binary verification
 * - generate_env_config: Shell export statement generation
 *
 * Other functions previously here are now tested in their canonical locations:
 * - _multi_creds_validate -> shared-common-credential-mgmt.test.ts
 * - _load_json_config_fields / _save_json_config -> shared-common-helpers.test.ts
 * - extract_ssh_key_ids -> shared-common-helpers.test.ts
 * - interactive_pick -> shared-common-input-validation.test.ts
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  try {
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? "").toString().trim(),
      stderr: (err.stderr ?? "").toString().trim(),
    };
  }
}

// ============================================================================
// log_install_failed
// ============================================================================

describe("log_install_failed", () => {
  it("should include agent name and install failed message", () => {
    const result = runBash(`log_install_failed "Claude Code" 2>&1`);
    expect(result.stdout).toContain("Claude Code");
    expect(result.stdout).toContain("installation failed");
  });

  it("should show SSH hint when server IP is provided", () => {
    const result = runBash(
      `log_install_failed "Codex" "" "10.0.0.5" 2>&1`
    );
    expect(result.stdout).toContain("ssh root@10.0.0.5");
  });

  it("should not show SSH hint when server IP is empty", () => {
    const result = runBash(`log_install_failed "Codex" "npm install -g codex" "" 2>&1`);
    expect(result.stdout).not.toContain("ssh root@");
  });

  it("should show install command hint when provided", () => {
    const result = runBash(
      `log_install_failed "Cline" "npm install -g cline" 2>&1`
    );
    expect(result.stdout).toContain("Try manual installation");
    expect(result.stdout).toContain("npm install -g cline");
  });

  it("should always show common causes section", () => {
    const result = runBash(`log_install_failed "Test" 2>&1`);
    expect(result.stdout).toContain("Common causes");
  });

  it("should not exit with an error code (informational only)", () => {
    const result = runBash(`log_install_failed "Test" "cmd" "1.2.3.4"`);
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================================
// ensure_jq
// ============================================================================

describe("ensure_jq", () => {
  it("should return 0 when jq is already installed", () => {
    const checkResult = runBash("command -v jq &>/dev/null && echo found || echo missing");
    if (checkResult.stdout === "found") {
      const result = runBash("ensure_jq 2>/dev/null");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should check for jq using command -v", () => {
    const result = runBash("type ensure_jq | head -5");
    expect(result.stdout).toContain("command -v jq");
  });
});

// ============================================================================
// verify_agent_installed
// ============================================================================

describe("verify_agent_installed", () => {
  it("should return 0 when command exists", () => {
    const result = runBash(`verify_agent_installed "bash"`);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when command does not exist", () => {
    const result = runBash(
      `verify_agent_installed "nonexistent_cmd_12345" 2>/dev/null`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should show diagnostic error on failure", () => {
    const result = runBash(
      `verify_agent_installed "nonexistent_cmd_12345" "--version" "Claude Code" 2>&1`
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Claude Code");
    expect(result.stdout).toContain("installation failed");
  });
});

// ============================================================================
// generate_env_config
// ============================================================================

describe("generate_env_config", () => {
  it("should generate export statements", () => {
    const result = runBash(`generate_env_config "MY_KEY=my_value"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export MY_KEY='my_value'");
  });

  it("should include spawn:env marker", () => {
    const result = runBash(`generate_env_config "K=V"`);
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should handle values containing equals signs", () => {
    const result = runBash(`generate_env_config "API_URL=https://example.com?key=abc"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export API_URL='https://example.com?key=abc'");
  });

  it("should produce sourceable bash output", () => {
    const result = runBash(`
      OUTPUT=$(generate_env_config "TEST_VAR=hello_world")
      eval "$OUTPUT"
      echo "$TEST_VAR"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello_world");
  });
});
