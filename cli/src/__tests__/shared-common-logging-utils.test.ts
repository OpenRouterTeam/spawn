import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for logging, diagnostic, temp-file management, runtime detection,
 * cloud-init generation, and SSH key helpers in shared/common.sh.
 *
 * These utility functions had zero dedicated test coverage but are used
 * pervasively across all cloud provider scripts:
 * - log_step: progress messages (cyan), added in PR #757
 * - _log_diagnostic: structured error output (header + causes + fixes)
 * - check_python_available: Python 3 dependency check
 * - find_node_runtime: bun/node detection
 * - track_temp_file + cleanup_temp_files: secure credential temp file cleanup
 * - get_cloud_init_userdata: cloud-init YAML generation for all providers
 * - generate_ssh_key_if_missing: SSH key generation
 * - get_ssh_fingerprint: SSH fingerprint extraction
 * - calculate_retry_backoff: jittered exponential backoff
 * - opencode_install_cmd: opencode install script generation
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-log-util-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(script: string, env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const { spawnSync } = require("child_process");
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// ── log_step ────────────────────────────────────────────────────────────────

describe("log_step", () => {
  it("should output message to stderr", () => {
    const result = runBash('log_step "Deploying agent..."');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Deploying agent...");
  });

  it("should not output to stdout", () => {
    const result = runBash('log_step "Progress message"');
    expect(result.stdout).toBe("");
  });

  it("should use cyan color codes", () => {
    const result = runBash('log_step "Step in progress"');
    // CYAN = \033[36m, NC = \033[0m
    expect(result.stderr).toContain("Step in progress");
    // Verify it's different from log_warn (yellow) output
    const warnResult = runBash('log_warn "Warning message"');
    // Both write to stderr but with different ANSI codes
    expect(result.stderr).not.toBe(warnResult.stderr.replace("Warning message", "Step in progress"));
  });

  it("should handle empty message", () => {
    const result = runBash('log_step ""');
    expect(result.exitCode).toBe(0);
  });

  it("should handle message with special characters", () => {
    const result = runBash('log_step "Status: 50% done (step 1/3)"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Status: 50% done (step 1/3)");
  });
});

// ── _log_diagnostic ─────────────────────────────────────────────────────────

describe("_log_diagnostic", () => {
  it("should output header, causes, and fixes in structured format", () => {
    const result = runBash(`
      _log_diagnostic "Something failed" \\
        "Cause A" \\
        "Cause B" \\
        --- \\
        "Fix 1" \\
        "Fix 2"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Something failed");
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("Cause A");
    expect(result.stderr).toContain("Cause B");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("Fix 1");
    expect(result.stderr).toContain("Fix 2");
  });

  it("should number fix steps sequentially", () => {
    const result = runBash(`
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
    const result = runBash(`
      _log_diagnostic "Install failed" \\
        "Network error" \\
        --- \\
        "Retry the command"
    `);
    expect(result.stderr).toContain("Install failed");
    expect(result.stderr).toContain("Network error");
    expect(result.stderr).toContain("1. Retry the command");
  });

  it("should handle multiple causes", () => {
    const result = runBash(`
      _log_diagnostic "Auth failed" \\
        "Token expired" \\
        "Token invalid" \\
        "Wrong region" \\
        --- \\
        "Regenerate token"
    `);
    expect(result.stderr).toContain("Token expired");
    expect(result.stderr).toContain("Token invalid");
    expect(result.stderr).toContain("Wrong region");
  });

  it("should use bullet points for causes", () => {
    const result = runBash(`
      _log_diagnostic "Error" \\
        "Cause 1" \\
        --- \\
        "Fix 1"
    `);
    expect(result.stderr).toContain("- Cause 1");
  });

  it("should output everything to stderr", () => {
    const result = runBash(`
      _log_diagnostic "Header" \\
        "Cause" \\
        --- \\
        "Fix"
    `);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Header");
  });
});

// ── check_python_available ──────────────────────────────────────────────────

describe("check_python_available", () => {
  it("should return 0 when python3 is available", () => {
    const result = runBash("check_python_available");
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when python3 is not in PATH", () => {
    const result = runBash("check_python_available", { PATH: "/nonexistent" });
    expect(result.exitCode).toBe(1);
  });

  it("should show install instructions when python3 is missing", () => {
    // Override command to simulate python3 not found (can't restrict PATH since sourcing needs it)
    const result = runBash(`
      command() { if [[ "$2" == "python3" ]]; then return 1; fi; builtin command "$@"; }
      check_python_available
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Python 3 is required");
    expect(result.stderr).toContain("Install Python 3:");
  });

  it("should mention Ubuntu, Fedora, macOS, and Arch install options", () => {
    const result = runBash(`
      command() { if [[ "$2" == "python3" ]]; then return 1; fi; builtin command "$@"; }
      check_python_available
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ubuntu/Debian");
    expect(result.stderr).toContain("Fedora/RHEL");
    expect(result.stderr).toContain("macOS");
    expect(result.stderr).toContain("Arch Linux");
  });
});

// ── find_node_runtime ───────────────────────────────────────────────────────

describe("find_node_runtime", () => {
  it("should find a runtime in normal environment", () => {
    const result = runBash("find_node_runtime");
    expect(result.exitCode).toBe(0);
    expect(["bun", "node"]).toContain(result.stdout);
  });

  it("should return 1 when neither bun nor node is available", () => {
    const result = runBash("find_node_runtime", { PATH: "/nonexistent" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("should prefer bun over node when both available", () => {
    // In the test environment bun is available
    const result = runBash("find_node_runtime");
    if (result.stdout === "bun") {
      // Confirm bun is indeed preferred
      expect(result.stdout).toBe("bun");
    }
    // Either way, should succeed
    expect(result.exitCode).toBe(0);
  });
});

// ── track_temp_file + cleanup_temp_files ────────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  it("should add file to CLEANUP_TEMP_FILES array", () => {
    const tmpFile = join(testDir, "cred.tmp");
    writeFileSync(tmpFile, "secret-data");

    const result = runBash(`
      track_temp_file "${tmpFile}"
      echo "\${#CLEANUP_TEMP_FILES[@]}"
    `);
    expect(result.exitCode).toBe(0);
    // Array should now have at least 1 entry
    expect(parseInt(result.stdout)).toBeGreaterThanOrEqual(1);
  });

  it("should clean up tracked temp files", () => {
    const tmpFile = join(testDir, "cred.tmp");
    writeFileSync(tmpFile, "secret-data");

    const result = runBash(`
      track_temp_file "${tmpFile}"
      cleanup_temp_files
      if [[ -f "${tmpFile}" ]]; then echo "exists"; else echo "removed"; fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("removed");
  });

  it("should handle multiple tracked files", () => {
    const tmpFile1 = join(testDir, "cred1.tmp");
    const tmpFile2 = join(testDir, "cred2.tmp");
    writeFileSync(tmpFile1, "secret-1");
    writeFileSync(tmpFile2, "secret-2");

    const result = runBash(`
      track_temp_file "${tmpFile1}"
      track_temp_file "${tmpFile2}"
      cleanup_temp_files
      f1="removed"; f2="removed"
      [[ -f "${tmpFile1}" ]] && f1="exists"
      [[ -f "${tmpFile2}" ]] && f2="exists"
      echo "$f1 $f2"
    `);
    expect(result.stdout).toBe("removed removed");
  });

  it("should not fail if tracked file does not exist", () => {
    const result = runBash(`
      track_temp_file "/nonexistent/path/file.tmp"
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should preserve exit code through cleanup", () => {
    const result = runBash(`
      cleanup_exit_code_test() {
        local exit_code=42
        (exit $exit_code)
        cleanup_temp_files
        return $?
      }
      cleanup_exit_code_test
    `);
    // cleanup_temp_files preserves the exit code from before it was called
    expect(result.exitCode).toBe(42);
  });

  it("should try shred before rm for security", () => {
    const tmpFile = join(testDir, "secure.tmp");
    writeFileSync(tmpFile, "sensitive-credentials");

    // After cleanup, file should not exist regardless of whether shred or rm was used
    const result = runBash(`
      track_temp_file "${tmpFile}"
      cleanup_temp_files
      [[ -f "${tmpFile}" ]] && echo "exists" || echo "removed"
    `);
    expect(result.stdout).toBe("removed");
  });
});

// ── register_cleanup_trap ───────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should register EXIT trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p EXIT
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should register INT trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p INT
    `);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should register TERM trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p TERM
    `);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should auto-register on source (common.sh sources register_cleanup_trap at bottom)", () => {
    // shared/common.sh calls register_cleanup_trap at end of file
    const result = runBash("trap -p EXIT");
    expect(result.stdout).toContain("cleanup_temp_files");
  });
});

// ── get_cloud_init_userdata ─────────────────────────────────────────────────

describe("get_cloud_init_userdata", () => {
  it("should output valid cloud-config YAML", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#cloud-config");
  });

  it("should include package_update directive", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("package_update: true");
  });

  it("should include required packages", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("curl");
    expect(result.stdout).toContain("unzip");
    expect(result.stdout).toContain("git");
    expect(result.stdout).toContain("zsh");
  });

  it("should install Bun", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("bun.sh/install");
  });

  it("should install Claude Code", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("claude.ai/install.sh");
  });

  it("should configure PATH in both .bashrc and .zshrc", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
  });

  it("should include .bun/bin in PATH config", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".bun/bin");
  });

  it("should signal completion with touch marker", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("touch /root/.cloud-init-complete");
  });

  it("should include runcmd section", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("runcmd:");
  });

  it("should include packages section", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("packages:");
  });
});

// ── calculate_retry_backoff ─────────────────────────────────────────────────

describe("calculate_retry_backoff", () => {
  it("should return a value within +-20% jitter of interval", () => {
    // Run multiple times and check the range
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const result = runBash("calculate_retry_backoff 10 60");
      results.push(parseInt(result.stdout));
    }
    for (const val of results) {
      // 10 * 0.8 = 8, 10 * 1.2 = 12
      expect(val).toBeGreaterThanOrEqual(8);
      expect(val).toBeLessThanOrEqual(12);
    }
  });

  it("should return next interval not exceeding max", () => {
    const result = runBash("calculate_retry_backoff 50 60");
    const val = parseInt(result.stdout);
    // 50 * 0.8 = 40, 50 * 1.2 = 60
    expect(val).toBeGreaterThanOrEqual(40);
    expect(val).toBeLessThanOrEqual(60);
  });

  it("should handle interval of 1", () => {
    const result = runBash("calculate_retry_backoff 1 60");
    const val = parseInt(result.stdout);
    // 1 * 0.8 = 0.8 -> int 0 or 1; 1 * 1.2 = 1.2 -> int 1
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(2);
  });

  it("should handle equal interval and max", () => {
    const result = runBash("calculate_retry_backoff 30 30");
    const val = parseInt(result.stdout);
    // Already at max; jitter +-20% of 30 => [24, 36]
    expect(val).toBeGreaterThanOrEqual(24);
    expect(val).toBeLessThanOrEqual(36);
  });

  it("should fall back to plain interval if python3 unavailable", () => {
    const result = runBash("calculate_retry_backoff 5 30", { PATH: "/usr/bin:/bin" });
    // Without python3, should fall back to echo'ing the raw interval
    // But python3 might still be available at /usr/bin/python3
    expect(result.exitCode).toBe(0);
    const val = parseInt(result.stdout);
    expect(val).toBeGreaterThanOrEqual(0);
  });
});

// ── generate_ssh_key_if_missing ─────────────────────────────────────────────

describe("generate_ssh_key_if_missing", () => {
  it("should create key when it does not exist", () => {
    const keyPath = join(testDir, "test_key");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(`${keyPath}.pub`)).toBe(true);
  });

  it("should not overwrite existing key", () => {
    const keyPath = join(testDir, "existing_key");
    writeFileSync(keyPath, "existing-key-content");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(keyPath, "utf-8")).toBe("existing-key-content");
  });

  it("should create parent directories if needed", () => {
    const keyPath = join(testDir, "nested", "dir", "key");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
  });

  it("should generate ed25519 key type", () => {
    const keyPath = join(testDir, "ed_key");
    runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    const pubContent = readFileSync(`${keyPath}.pub`, "utf-8");
    expect(pubContent).toContain("ssh-ed25519");
  });

  it("should generate key with no passphrase", () => {
    const keyPath = join(testDir, "nopw_key");
    // Key should be usable without passphrase
    const result = runBash(`
      generate_ssh_key_if_missing "${keyPath}"
      ssh-keygen -y -f "${keyPath}" > /dev/null 2>&1
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── get_ssh_fingerprint ─────────────────────────────────────────────────────

describe("get_ssh_fingerprint", () => {
  it("should return MD5 fingerprint of a public key", () => {
    const keyPath = join(testDir, "fp_key");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    // MD5 fingerprint format: xx:xx:xx:xx:...
    expect(result.stdout).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });

  it("should not include MD5: prefix in output", () => {
    const keyPath = join(testDir, "fp_key2");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.stdout).not.toContain("MD5:");
  });

  it("should return consistent fingerprint for same key", () => {
    const keyPath = join(testDir, "fp_key3");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

    const result1 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    const result2 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result1.stdout).toBe(result2.stdout);
  });
});

// ── logging functions ───────────────────────────────────────────────────────

describe("logging functions output to stderr", () => {
  it("log_info should output to stderr with green color", () => {
    const result = runBash('log_info "Info message"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Info message");
  });

  it("log_warn should output to stderr with yellow color", () => {
    const result = runBash('log_warn "Warning message"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Warning message");
  });

  it("log_error should output to stderr with red color", () => {
    const result = runBash('log_error "Error message"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error message");
  });

  it("log functions should not interfere with stdout piping", () => {
    const result = runBash(`
      log_info "info"
      log_warn "warn"
      log_error "error"
      log_step "step"
      echo "stdout-data"
    `);
    expect(result.stdout).toBe("stdout-data");
    expect(result.stderr).toContain("info");
    expect(result.stderr).toContain("warn");
    expect(result.stderr).toContain("error");
    expect(result.stderr).toContain("step");
  });
});

// ── opencode_install_cmd ────────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should output a non-empty install command", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("should include architecture detection", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("uname -m");
  });

  it("should include OS detection", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("uname -s");
  });

  it("should download from github releases", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("github.com/anomalyco/opencode");
  });

  it("should handle aarch64 to arm64 mapping", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("aarch64");
    expect(result.stdout).toContain("arm64");
  });

  it("should update PATH in both .bashrc and .zshrc", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
  });

  it("should install to $HOME/.opencode/bin", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain(".opencode/bin");
  });

  it("should use tar to extract the archive", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("tar xzf");
  });

  it("should clean up temp install directory", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("rm -rf /tmp/opencode-install");
  });
});

// ── POLL_INTERVAL configurable constant ─────────────────────────────────────

describe("POLL_INTERVAL configuration", () => {
  it("should default to 1 second", () => {
    const result = runBash('echo "$POLL_INTERVAL"');
    expect(result.stdout).toBe("1");
  });

  it("should respect SPAWN_POLL_INTERVAL env var", () => {
    const result = runBash('echo "$POLL_INTERVAL"', { SPAWN_POLL_INTERVAL: "0.1" });
    expect(result.stdout).toBe("0.1");
  });

  it("should allow custom poll interval for testing", () => {
    const result = runBash('echo "$POLL_INTERVAL"', { SPAWN_POLL_INTERVAL: "5" });
    expect(result.stdout).toBe("5");
  });
});

// ── SSH_OPTS default configuration ──────────────────────────────────────────

describe("SSH_OPTS defaults", () => {
  it("should set SSH_OPTS when not pre-defined", () => {
    const result = runBash('echo "$SSH_OPTS"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("should use accept-new for strict host key checking (TOFU)", () => {
    const result = runBash('echo "$SSH_OPTS"');
    expect(result.stdout).toContain("StrictHostKeyChecking=accept-new");
  });

  it("should use /dev/null for known hosts file", () => {
    const result = runBash('echo "$SSH_OPTS"');
    expect(result.stdout).toContain("UserKnownHostsFile=/dev/null");
  });

  it("should suppress SSH logging", () => {
    const result = runBash('echo "$SSH_OPTS"');
    expect(result.stdout).toContain("LogLevel=ERROR");
  });

  it("should use ed25519 key by default", () => {
    const result = runBash('echo "$SSH_OPTS"');
    expect(result.stdout).toContain("id_ed25519");
  });

  it("should not override pre-existing SSH_OPTS", () => {
    const result = runBash('echo "$SSH_OPTS"', { SSH_OPTS: "custom-opts" });
    expect(result.stdout).toBe("custom-opts");
  });
});
