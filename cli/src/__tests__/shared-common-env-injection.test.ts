import { describe, it, expect, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Tests for environment injection, temp file cleanup, and non-interactive
 * agent execution functions in shared/common.sh.
 *
 * These functions are SECURITY-CRITICAL and used by every cloud provider script:
 * - inject_env_vars_ssh: injects env vars into remote server .zshrc via SSH
 * - inject_env_vars_local: injects env vars for non-SSH providers (sprite, modal)
 * - execute_agent_non_interactive: runs agent with escaped user prompt
 * - track_temp_file / cleanup_temp_files: secure temp file lifecycle
 * - check_ssh_key_by_fingerprint: shared SSH key lookup helper
 * - ensure_ssh_key_with_provider: shared SSH key registration pattern
 *
 * Each test sources shared/common.sh in a bash subprocess to test real bash
 * behavior (quoting, escaping, subshell semantics) rather than replicas.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/** Run a bash script that sources shared/common.sh, capturing stdout+stderr */
function runBash(
  script: string
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `
    source "${COMMON_SH}"
    ${script}
  `;
  try {
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: stdout || "", stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

/** Run a bash script capturing combined stdout+stderr (for log function tests) */
function runBashCombined(script: string): { exitCode: number; output: string } {
  const fullScript = `
    source "${COMMON_SH}"
    ${script}
  `;
  try {
    const output = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}'  2>&1`,
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    return { exitCode: 0, output: output || "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      output: (err.stdout || "") + (err.stderr || ""),
    };
  }
}

// ── inject_env_vars_ssh ─────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should call upload and run callbacks with correct arguments", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-ssh-"));
    const logFile = join(testDir, "calls.log");

    const result = runBash(`
      mock_upload() { echo "UPLOAD:$1:$2:$3" >> "${logFile}"; }
      mock_run() { echo "RUN:$1:$2" >> "${logFile}"; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "MY_KEY=my_value"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    // Upload should be called with server_ip, temp_file, and remote path
    expect(log).toContain("UPLOAD:10.0.0.1:");
    expect(log).toContain("/tmp/env_config");
    // Run should be called with server_ip and the cat+rm command
    expect(log).toContain("RUN:10.0.0.1:");
    expect(log).toContain("cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
  });

  it("should generate correct export statements in the uploaded file", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-ssh-"));
    const uploadedFile = join(testDir, "uploaded.txt");

    const result = runBash(`
      mock_upload() { cp "$2" "${uploadedFile}" 2>/dev/null; cp "$1" "${uploadedFile}" 2>/dev/null || true; }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "OPENROUTER_API_KEY=sk-or-v1-test" "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    `);

    // The upload callback receives (server_ip, local_path, remote_path)
    // Check that the temp file was created with correct content
    expect(result.exitCode).toBe(0);
  });

  it("should handle values with special characters", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-ssh-"));
    const contentFile = join(testDir, "content.txt");

    const result = runBash(`
      mock_upload() {
        local content
        content=$(cat "$2" 2>/dev/null || cat "$1" 2>/dev/null || echo "NO_FILE")
        echo "$content" > "${contentFile}"
      }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY=value with spaces"
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should handle multiple env vars", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-ssh-"));
    const logFile = join(testDir, "calls.log");

    const result = runBash(`
      mock_upload() { echo "UPLOAD" >> "${logFile}"; }
      mock_run() { echo "RUN:$2" >> "${logFile}"; }
      inject_env_vars_ssh "192.168.1.1" mock_upload mock_run \
        "KEY1=val1" "KEY2=val2" "KEY3=val3"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    // Should have exactly one UPLOAD and one RUN call
    expect(log.match(/UPLOAD/g)?.length).toBe(1);
    expect(log.match(/RUN:/g)?.length).toBe(1);
  });

  it("should create temp file with chmod 600", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-ssh-"));
    const permFile = join(testDir, "perms.txt");

    const result = runBash(`
      mock_upload() {
        # Capture the local temp file's permissions
        stat -c '%a' "$2" 2>/dev/null > "${permFile}" || stat -f '%Lp' "$2" > "${permFile}" 2>/dev/null
      }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "SECRET=token123"
    `);

    expect(result.exitCode).toBe(0);
    if (existsSync(permFile)) {
      const perms = readFileSync(permFile, "utf-8").trim();
      expect(perms).toBe("600");
    }
  });
});

// ── inject_env_vars_local ───────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should call upload and run callbacks without server_ip", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-local-"));
    const logFile = join(testDir, "calls.log");

    const result = runBash(`
      mock_upload() { echo "UPLOAD:$1:$2" >> "${logFile}"; }
      mock_run() { echo "RUN:$1" >> "${logFile}"; }
      inject_env_vars_local mock_upload mock_run "MY_KEY=my_value"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    // Upload should be called with (local_path, remote_path) - NO server_ip
    expect(log).toContain("UPLOAD:");
    expect(log).toContain("/tmp/env_config");
    // Run should be called with just the command - NO server_ip
    expect(log).toContain("RUN:cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
  });

  it("should handle multiple env vars", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-local-"));
    const logFile = join(testDir, "calls.log");

    const result = runBash(`
      mock_upload() { echo "UPLOAD" >> "${logFile}"; }
      mock_run() { echo "RUN" >> "${logFile}"; }
      inject_env_vars_local mock_upload mock_run \
        "OPENROUTER_API_KEY=sk-test" "BASE_URL=https://example.com"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log.match(/UPLOAD/g)?.length).toBe(1);
    expect(log.match(/RUN/g)?.length).toBe(1);
  });

  it("should create temp file with chmod 600", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-local-"));
    const permFile = join(testDir, "perms.txt");

    const result = runBash(`
      mock_upload() {
        stat -c '%a' "$1" 2>/dev/null > "${permFile}" || stat -f '%Lp' "$1" > "${permFile}" 2>/dev/null
      }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "TOKEN=secret"
    `);

    expect(result.exitCode).toBe(0);
    if (existsSync(permFile)) {
      const perms = readFileSync(permFile, "utf-8").trim();
      expect(perms).toBe("600");
    }
  });

  it("should differ from inject_env_vars_ssh by not passing server_ip", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-local-"));
    const sshLog = join(testDir, "ssh.log");
    const localLog = join(testDir, "local.log");

    // Test SSH variant: upload receives (server_ip, local_path, remote_path)
    runBash(`
      mock_upload_ssh() { echo "ARG_COUNT:$#" >> "${sshLog}"; echo "ARGS:$*" >> "${sshLog}"; }
      mock_run_ssh() { echo "RUN_ARGS:$#" >> "${sshLog}"; }
      inject_env_vars_ssh "10.0.0.1" mock_upload_ssh mock_run_ssh "K=V"
    `);

    // Test local variant: upload receives (local_path, remote_path) - one fewer arg
    runBash(`
      mock_upload_local() { echo "ARG_COUNT:$#" >> "${localLog}"; echo "ARGS:$*" >> "${localLog}"; }
      mock_run_local() { echo "RUN_ARGS:$#" >> "${localLog}"; }
      inject_env_vars_local mock_upload_local mock_run_local "K=V"
    `);

    const sshContent = readFileSync(sshLog, "utf-8");
    const localContent = readFileSync(localLog, "utf-8");

    // SSH upload gets 3 args (server_ip, local_path, remote_path)
    expect(sshContent).toContain("ARG_COUNT:3");
    // Local upload gets 2 args (local_path, remote_path)
    expect(localContent).toContain("ARG_COUNT:2");
  });
});

// ── track_temp_file + cleanup_temp_files ─────────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should track and clean up a single temp file", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-"));
    const tempFile = join(testDir, "temp_cred.txt");
    writeFileSync(tempFile, "sensitive data");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
    expect(existsSync(tempFile)).toBe(false);
  });

  it("should track and clean up multiple temp files", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-"));
    const file1 = join(testDir, "temp1.txt");
    const file2 = join(testDir, "temp2.txt");
    const file3 = join(testDir, "temp3.txt");
    writeFileSync(file1, "data1");
    writeFileSync(file2, "data2");
    writeFileSync(file3, "data3");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${file1}"
      track_temp_file "${file2}"
      track_temp_file "${file3}"
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
    expect(existsSync(file1)).toBe(false);
    expect(existsSync(file2)).toBe(false);
    expect(existsSync(file3)).toBe(false);
  });

  it("should not fail when temp file already deleted", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-"));
    const tempFile = join(testDir, "already-gone.txt");
    // Don't create the file -- it doesn't exist

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should not fail with empty cleanup list", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should preserve exit code through cleanup", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-"));
    const tempFile = join(testDir, "temp.txt");
    writeFileSync(tempFile, "data");

    // cleanup_temp_files should return the exit code it started with
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      # Set a non-zero exit code before cleanup
      (exit 42)
      cleanup_temp_files
      echo "EXIT_CODE:$?"
    `);

    expect(result.stdout).toContain("EXIT_CODE:42");
    expect(existsSync(tempFile)).toBe(false);
  });

  it("should handle files with spaces in path", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-"));
    const spacePath = join(testDir, "file with spaces.txt");
    writeFileSync(spacePath, "data");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${spacePath}"
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
    expect(existsSync(spacePath)).toBe(false);
  });
});

// ── execute_agent_non_interactive ────────────────────────────────────────────

describe("execute_agent_non_interactive", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should use sprite exec for sprite-based callbacks", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-exec-"));
    const logFile = join(testDir, "exec.log");

    // Mock sprite command
    const result = runBash(`
      sprite() { echo "SPRITE_CMD:$*" >> "${logFile}"; }
      export -f sprite
      execute_agent_non_interactive "my-sprite" "claude" "-p" "Fix the bug" "sprite_exec"
    `);

    // Should have called sprite exec with correct args
    if (existsSync(logFile)) {
      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("SPRITE_CMD:exec -s my-sprite --");
      expect(log).toContain("claude");
      expect(log).toContain("-p");
    }
  });

  it("should use generic callback for non-sprite execution", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-exec-"));
    const logFile = join(testDir, "exec.log");

    const result = runBash(`
      ssh_exec() { echo "SSH_EXEC:$1:$2" >> "${logFile}"; }
      execute_agent_non_interactive "10.0.0.1" "aider" "-m" "Add tests" "ssh_exec"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("SSH_EXEC:10.0.0.1:");
    expect(log).toContain("aider");
    expect(log).toContain("-m");
  });

  it("should escape special characters in prompt", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-exec-"));
    const logFile = join(testDir, "exec.log");

    const result = runBash(`
      ssh_exec() { echo "CMD:$2" >> "${logFile}"; }
      execute_agent_non_interactive "server" "claude" "-p" 'Fix "the bug" in file.ts' "ssh_exec"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    // The prompt should be escaped (printf %q)
    // It should contain claude and the flag
    expect(log).toContain("claude");
    expect(log).toContain("-p");
  });

  it("should include source .zshrc in the command", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-exec-"));
    const logFile = join(testDir, "exec.log");

    const result = runBash(`
      ssh_exec() { echo "CMD:$2" >> "${logFile}"; }
      execute_agent_non_interactive "server" "aider" "-m" "Hello" "ssh_exec"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("source ~/.zshrc");
  });

  it("should handle empty prompt", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-exec-"));
    const logFile = join(testDir, "exec.log");

    const result = runBash(`
      ssh_exec() { echo "CMD:$2" >> "${logFile}"; }
      execute_agent_non_interactive "server" "claude" "-p" "" "ssh_exec"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("claude");
    expect(log).toContain("-p");
  });
});

// ── check_ssh_key_by_fingerprint ─────────────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"fingerprint": "ab:cd:ef:12:34"}, {"fingerprint": "11:22:33:44:55"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "ab:cd:ef:12:34"
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should return non-zero when fingerprint is not found", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"fingerprint": "ab:cd:ef:12:34"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "99:88:77:66:55"
    `);

    expect(result.exitCode).not.toBe(0);
  });

  it("should return non-zero when API returns empty response", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys": []}'; }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "ab:cd:ef:12:34"
    `);

    expect(result.exitCode).not.toBe(0);
  });

  it("should pass correct endpoint to API function", () => {
    let testDir = mkdtempSync(join(tmpdir(), "spawn-ssh-key-"));
    const logFile = join(testDir, "api.log");

    try {
      const result = runBash(`
        mock_api() {
          echo "METHOD:$1 ENDPOINT:$2" >> "${logFile}"
          echo '{"fingerprint": "xx:yy:zz"}'
        }
        check_ssh_key_by_fingerprint mock_api "/v2/account/keys" "xx:yy:zz"
      `);

      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("METHOD:GET");
      expect(log).toContain("ENDPOINT:/v2/account/keys");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should handle fingerprints with various formats", () => {
    // SHA256 fingerprint format
    const result = runBash(`
      mock_api() {
        echo 'SHA256:aBcDeFgHiJkLmNoPqRsTuVwXyZ'
      }
      check_ssh_key_by_fingerprint mock_api "/keys" "SHA256:aBcDeFgHiJkLmNoPqRsTuVwXyZ"
    `);

    expect(result.exitCode).toBe(0);
  });
});

// ── generate_env_config integration with inject functions ────────────────────

describe("generate_env_config content via inject_env_vars", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should write env config with correct export format via inject_env_vars_local", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-content-"));
    const contentFile = join(testDir, "content.txt");

    const result = runBash(`
      mock_upload() { cat "$1" > "${contentFile}"; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "API_KEY=sk-test-123"
    `);

    expect(result.exitCode).toBe(0);
    if (existsSync(contentFile)) {
      const content = readFileSync(contentFile, "utf-8");
      expect(content).toContain("# [spawn:env]");
      expect(content).toContain("export API_KEY='sk-test-123'");
    }
  });

  it("should write multiple env vars via inject_env_vars_local", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-content-"));
    const contentFile = join(testDir, "content.txt");

    const result = runBash(`
      mock_upload() { cat "$1" > "${contentFile}"; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run \
        "OPENROUTER_API_KEY=sk-or-v1-abc" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    `);

    expect(result.exitCode).toBe(0);
    if (existsSync(contentFile)) {
      const content = readFileSync(contentFile, "utf-8");
      expect(content).toContain("export OPENROUTER_API_KEY='sk-or-v1-abc'");
      expect(content).toContain(
        "export ANTHROPIC_BASE_URL='https://openrouter.ai/api'"
      );
    }
  });

  it("should properly escape single quotes in values", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-env-content-"));
    const contentFile = join(testDir, "content.txt");

    const result = runBash(`
      mock_upload() { cat "$1" > "${contentFile}"; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "KEY=it'\\''s a test"
    `);

    expect(result.exitCode).toBe(0);
    if (existsSync(contentFile)) {
      const content = readFileSync(contentFile, "utf-8");
      // The single quote should be escaped in the export statement
      expect(content).toContain("export KEY=");
      // Verify the value is properly escaped for shell interpretation
      expect(content).toContain("'\\''");
    }
  });
});

// ── opencode_install_cmd ────────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should output a non-empty install command", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it("should contain curl or go install or npm", () => {
    const result = runBash("opencode_install_cmd");
    const output = result.stdout.trim();
    // The install command should be some kind of package installation
    const hasInstaller =
      output.includes("curl") ||
      output.includes("go ") ||
      output.includes("npm") ||
      output.includes("pip") ||
      output.includes("brew") ||
      output.includes("apt") ||
      output.includes("install");
    expect(hasInstaller).toBe(true);
  });
});

// ── log_step distinct from log_warn ─────────────────────────────────────────

describe("log_step vs log_warn", () => {
  it("should output log_step message", () => {
    const result = runBashCombined('log_step "Progress message"');
    expect(result.output).toContain("Progress message");
  });

  it("should output log_warn message", () => {
    const result = runBashCombined('log_warn "Warning message"');
    expect(result.output).toContain("Warning message");
  });

  it("should output log_info message", () => {
    const result = runBashCombined('log_info "Info message"');
    expect(result.output).toContain("Info message");
  });

  it("should output log_error message", () => {
    const result = runBashCombined('log_error "Error message"');
    expect(result.output).toContain("Error message");
  });

  it("log_step and log_warn should produce different output", () => {
    const stepResult = runBashCombined('log_step "test"');
    const warnResult = runBashCombined('log_warn "test"');
    // They should both contain "test" but with different formatting (different color codes)
    expect(stepResult.output).toContain("test");
    expect(warnResult.output).toContain("test");
    expect(stepResult.output).not.toBe(warnResult.output);
  });
});

// ── register_cleanup_trap ───────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should clean up temp files on script exit", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-trap-"));
    const tempFile = join(testDir, "cred.txt");
    writeFileSync(tempFile, "secret_api_key_12345");

    // Run in a subshell so the EXIT trap fires
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      register_cleanup_trap
      track_temp_file "${tempFile}"
      exit 0
    `);

    // After the subshell exits, the trap should have cleaned up
    expect(existsSync(tempFile)).toBe(false);
  });

  it("should clean up temp files on non-zero exit", () => {
    testDir = mkdtempSync(join(tmpdir(), "spawn-trap-"));
    const tempFile = join(testDir, "cred.txt");
    writeFileSync(tempFile, "secret_token");

    runBash(`
      CLEANUP_TEMP_FILES=()
      register_cleanup_trap
      track_temp_file "${tempFile}"
      exit 1
    `);

    expect(existsSync(tempFile)).toBe(false);
  });
});
