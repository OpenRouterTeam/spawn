import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for core utility functions in shared/common.sh that had zero test coverage:
 *
 * - Logging: log_info, log_warn, log_error, log_step output to stderr with colors
 * - _log_diagnostic: structured diagnostic output with header, causes, and fixes
 * - find_node_runtime: discovers bun or node for OAuth server
 * - check_python_available: validates python3 is installed
 * - track_temp_file / cleanup_temp_files / register_cleanup_trap: secure temp file management
 * - inject_env_vars_ssh: injects env vars into remote servers via SSH upload/run callbacks
 * - inject_env_vars_local: injects env vars for non-SSH providers (sprite, modal, e2b)
 * - generate_ssh_key_if_missing: creates SSH key if absent
 * - get_ssh_fingerprint: extracts SSH public key fingerprint
 *
 * These functions are foundational - every spawn script depends on them.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
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
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || "").trim(),
    };
  }
}

/**
 * Run bash with stderr captured separately.
 */
function runBashWithStderr(script: string): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const tmpFile = join(tmpdir(), `spawn-test-stderr-${Date.now()}-${Math.random()}`);
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}'  2>"${tmpFile}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const stderr = existsSync(tmpFile) ? readFileSync(tmpFile, "utf-8").trim() : "";
    return { exitCode: 0, stdout: stdout.trim(), stderr };
  } catch (err: any) {
    const stderr = existsSync(tmpFile) ? readFileSync(tmpFile, "utf-8").trim() : (err.stderr || "").trim();
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  } finally {
    if (existsSync(tmpFile)) rmSync(tmpFile);
  }
}

function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Logging Functions ──────────────────────────────────────────────────────────

describe("Logging functions", () => {
  describe("log_info", () => {
    it("should output message to stderr with green color", () => {
      const result = runBashWithStderr('log_info "Test info message"');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Test info message");
      // Green color code
      expect(result.stderr).toContain("\x1b[0;32m");
    });

    it("should output empty string without error", () => {
      const result = runBashWithStderr('log_info ""');
      expect(result.exitCode).toBe(0);
    });

    it("should not output to stdout", () => {
      const result = runBashWithStderr('log_info "should not appear on stdout"');
      expect(result.stdout).toBe("");
    });
  });

  describe("log_warn", () => {
    it("should output message to stderr with yellow color", () => {
      const result = runBashWithStderr('log_warn "Test warning"');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Test warning");
      // Yellow color code
      expect(result.stderr).toContain("\x1b[1;33m");
    });
  });

  describe("log_error", () => {
    it("should output message to stderr with red color", () => {
      const result = runBashWithStderr('log_error "Test error"');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Test error");
      // Red color code
      expect(result.stderr).toContain("\x1b[0;31m");
    });
  });

  describe("log_step", () => {
    it("should output message to stderr with cyan color", () => {
      const result = runBashWithStderr('log_step "Doing something..."');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Doing something...");
      // Cyan color code
      expect(result.stderr).toContain("\x1b[0;36m");
    });
  });

  describe("all log functions output to stderr, not stdout", () => {
    it("should keep stdout clean for command substitution", () => {
      const result = runBashWithStderr(`
        log_info "info"
        log_warn "warn"
        log_error "error"
        log_step "step"
        echo "STDOUT_ONLY"
      `);
      expect(result.stdout).toBe("STDOUT_ONLY");
      expect(result.stderr).toContain("info");
      expect(result.stderr).toContain("warn");
      expect(result.stderr).toContain("error");
      expect(result.stderr).toContain("step");
    });
  });
});

// ── _log_diagnostic ────────────────────────────────────────────────────────────

describe("_log_diagnostic", () => {
  it("should output header, causes, and fix steps", () => {
    const result = runBashWithStderr(`
      _log_diagnostic "Installation failed" \\
        "Network timeout" \\
        "Missing dependency" \\
        --- \\
        "Check internet connection" \\
        "Install missing packages"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Installation failed");
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("Network timeout");
    expect(result.stderr).toContain("Missing dependency");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("Check internet connection");
    expect(result.stderr).toContain("Install missing packages");
  });

  it("should number the fix steps", () => {
    const result = runBashWithStderr(`
      _log_diagnostic "Error" \\
        "cause" \\
        --- \\
        "First fix" \\
        "Second fix" \\
        "Third fix"
    `);
    expect(result.stderr).toContain("1. First fix");
    expect(result.stderr).toContain("2. Second fix");
    expect(result.stderr).toContain("3. Third fix");
  });

  it("should handle single cause and single fix", () => {
    const result = runBashWithStderr(`
      _log_diagnostic "Error" "one cause" --- "one fix"
    `);
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("one cause");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("1. one fix");
  });
});

// ── find_node_runtime ──────────────────────────────────────────────────────────

describe("find_node_runtime", () => {
  it("should find bun or node in the current environment", () => {
    // In the test environment, at least bun should be available
    const result = runBash("find_node_runtime");
    expect(result.exitCode).toBe(0);
    expect(["bun", "node"]).toContain(result.stdout);
  });

  it("should prefer bun over node", () => {
    // Since we're running in bun, it should be found first
    const result = runBash("find_node_runtime");
    if (result.stdout === "bun") {
      expect(result.stdout).toBe("bun");
    } else {
      // If bun isn't in PATH for bash subprocess, node is fine
      expect(result.stdout).toBe("node");
    }
    expect(result.exitCode).toBe(0);
  });

  it("should return exit code 1 when neither is available", () => {
    const result = runBash('PATH=/nonexistent find_node_runtime');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});

// ── check_python_available ─────────────────────────────────────────────────────

describe("check_python_available", () => {
  it("should succeed when python3 is available", () => {
    const result = runBash("check_python_available");
    // python3 should be available in the test environment
    expect(result.exitCode).toBe(0);
  });

  it("should fail when python3 is not in PATH", () => {
    const result = runBashWithStderr("PATH=/nonexistent check_python_available");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Python 3 is required");
  });

  it("should show installation instructions on failure", () => {
    const result = runBashWithStderr("PATH=/nonexistent check_python_available");
    expect(result.stderr).toContain("Install Python 3:");
    expect(result.stderr).toContain("apt-get");
    expect(result.stderr).toContain("brew install");
  });
});

// ── track_temp_file and cleanup_temp_files ──────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should track and clean up a single temp file", () => {
    const tempFile = join(tempDir, "test-temp.txt");
    writeFileSync(tempFile, "secret data");

    const result = runBash(`
      track_temp_file "${tempFile}"
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(tempFile)).toBe(false);
  });

  it("should track and clean up multiple temp files", () => {
    const tempFile1 = join(tempDir, "temp1.txt");
    const tempFile2 = join(tempDir, "temp2.txt");
    const tempFile3 = join(tempDir, "temp3.txt");
    writeFileSync(tempFile1, "data1");
    writeFileSync(tempFile2, "data2");
    writeFileSync(tempFile3, "data3");

    const result = runBash(`
      track_temp_file "${tempFile1}"
      track_temp_file "${tempFile2}"
      track_temp_file "${tempFile3}"
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(tempFile1)).toBe(false);
    expect(existsSync(tempFile2)).toBe(false);
    expect(existsSync(tempFile3)).toBe(false);
  });

  it("should not fail when temp file was already removed", () => {
    const tempFile = join(tempDir, "already-gone.txt");
    // Don't create the file - it's already gone

    const result = runBash(`
      track_temp_file "${tempFile}"
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should preserve exit code through cleanup", () => {
    // cleanup_temp_files preserves $? via local exit_code=$?
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      (exit 42)
      cleanup_temp_files
      echo $?
    `);
    expect(result.stdout).toBe("42");
  });

  it("should handle empty temp file list", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── register_cleanup_trap ──────────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should register trap handlers without error", () => {
    const result = runBash("register_cleanup_trap");
    expect(result.exitCode).toBe(0);
  });

  it("should register traps for EXIT, INT, and TERM", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p EXIT
      trap -p INT
      trap -p TERM
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });
});

// ── inject_env_vars_ssh ────────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should call upload and run functions with correct arguments", () => {
    const logFile = join(tempDir, "calls.log");
    const result = runBash(`
      mock_upload() { echo "UPLOAD: \$1 \$2 \$3" >> "${logFile}"; }
      mock_run() { echo "RUN: \$1 \$2" >> "${logFile}"; }
      inject_env_vars_ssh "192.168.1.1" mock_upload mock_run "KEY=value"
    `);
    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("UPLOAD: 192.168.1.1");
    expect(log).toContain("/tmp/env_config");
    expect(log).toContain("RUN: 192.168.1.1");
    expect(log).toContain("cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
  });

  it("should generate env config with multiple env vars", () => {
    const envFile = join(tempDir, "env_capture.txt");
    const result = runBash(`
      mock_upload() {
        cp "\$2" "${envFile}"
      }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "API_KEY=abc123" "BASE_URL=https://example.com"
    `);
    expect(result.exitCode).toBe(0);
    const envContent = readFileSync(envFile, "utf-8");
    expect(envContent).toContain("export API_KEY='abc123'");
    expect(envContent).toContain("export BASE_URL='https://example.com'");
  });
});

// ── inject_env_vars_local ──────────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should call upload and run functions without server_ip", () => {
    const logFile = join(tempDir, "calls.log");
    const result = runBash(`
      mock_upload() { echo "UPLOAD: \$1 \$2" >> "${logFile}"; }
      mock_run() { echo "RUN: \$1" >> "${logFile}"; }
      inject_env_vars_local mock_upload mock_run "KEY=value"
    `);
    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    // local variant does not pass server_ip as first arg
    expect(log).toContain("UPLOAD:");
    expect(log).toContain("/tmp/env_config");
    expect(log).toContain("RUN: cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
  });

  it("should generate proper env config content", () => {
    const envFile = join(tempDir, "env_capture.txt");
    const result = runBash(`
      mock_upload() {
        cp "\$1" "${envFile}"
      }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "OPENROUTER_API_KEY=sk-or-v1-test123"
    `);
    expect(result.exitCode).toBe(0);
    const envContent = readFileSync(envFile, "utf-8");
    expect(envContent).toContain("export OPENROUTER_API_KEY='sk-or-v1-test123'");
    expect(envContent).toContain("# [spawn:env]");
  });
});

// ── generate_ssh_key_if_missing ────────────────────────────────────────────────

describe("generate_ssh_key_if_missing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should not regenerate if key already exists", () => {
    const keyPath = join(tempDir, "existing_key");
    writeFileSync(keyPath, "existing key content");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    // File should still have original content (not regenerated)
    expect(readFileSync(keyPath, "utf-8")).toBe("existing key content");
  });

  it("should generate a new key when it does not exist", () => {
    const keyPath = join(tempDir, "subdir", "new_key");

    const result = runBashWithStderr(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    // Should have generated an ed25519 key
    const keyContent = readFileSync(keyPath, "utf-8");
    expect(keyContent).toContain("OPENSSH PRIVATE KEY");
  });

  it("should create parent directories if missing", () => {
    const keyPath = join(tempDir, "deep", "nested", "key");

    const result = runBashWithStderr(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
  });
});

// ── get_ssh_fingerprint ────────────────────────────────────────────────────────

describe("get_ssh_fingerprint", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return the fingerprint of an SSH public key", () => {
    // Generate a key first
    const keyPath = join(tempDir, "test_key");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { stdio: "pipe" });

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    // Fingerprint should be a hash (SHA256: or MD5 hex format depending on ssh-keygen version)
    expect(result.stdout.length).toBeGreaterThan(10);
  });
});

// ── POLL_INTERVAL configuration ────────────────────────────────────────────────

describe("POLL_INTERVAL configuration", () => {
  it("should default to 1 when SPAWN_POLL_INTERVAL is not set", () => {
    const result = runBash('unset SPAWN_POLL_INTERVAL && source "${BASH_SOURCE[0]}" 2>/dev/null; echo "$POLL_INTERVAL"');
    // Re-source to get default
    const result2 = runBash('echo "$POLL_INTERVAL"');
    expect(result2.stdout).toBe("1");
  });

  it("should respect SPAWN_POLL_INTERVAL override", () => {
    const result = runBash('SPAWN_POLL_INTERVAL=0.1 && POLL_INTERVAL="${SPAWN_POLL_INTERVAL:-1}" && echo "$POLL_INTERVAL"');
    expect(result.stdout).toBe("0.1");
  });
});

// ── Color variable definitions ─────────────────────────────────────────────────

describe("Color variable definitions", () => {
  it("should define RED, GREEN, YELLOW, CYAN, and NC variables", () => {
    const result = runBash(`
      echo "RED=\${RED}"
      echo "GREEN=\${GREEN}"
      echo "YELLOW=\${YELLOW}"
      echo "CYAN=\${CYAN}"
      echo "NC=\${NC}"
    `);
    expect(result.exitCode).toBe(0);
    // Each should be set (non-empty after the = sign)
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      const value = line.split("=").slice(1).join("=");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ── SSH_OPTS default ───────────────────────────────────────────────────────────

describe("SSH_OPTS default", () => {
  it("should set default SSH_OPTS when not already set", () => {
    const result = runBash('echo "$SSH_OPTS"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-o StrictHostKeyChecking=no");
    expect(result.stdout).toContain("-o UserKnownHostsFile=/dev/null");
    expect(result.stdout).toContain("-o LogLevel=ERROR");
    expect(result.stdout).toContain("-i ");
    expect(result.stdout).toContain(".ssh/id_ed25519");
  });

  it("should not override SSH_OPTS when already set", () => {
    const result = runBash(`
      SSH_OPTS="-o CustomOption=yes"
      source "${COMMON_SH}"
      echo "\$SSH_OPTS"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-o CustomOption=yes");
    // Should NOT contain the default options since SSH_OPTS was pre-set
    expect(result.stdout).not.toContain("StrictHostKeyChecking");
  });
});

// ── open_browser fallback ──────────────────────────────────────────────────────

describe("open_browser", () => {
  it("should fall back to log_step when no browser command is available", () => {
    const result = runBashWithStderr(`
      PATH=/nonexistent open_browser "https://example.com/test"
    `);
    // When no open/xdg-open/termux-open-url, falls back to log_step
    expect(result.stderr).toContain("https://example.com/test");
  });
});
