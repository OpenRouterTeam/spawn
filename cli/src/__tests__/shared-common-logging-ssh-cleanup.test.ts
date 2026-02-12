import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for previously untested shared/common.sh functions:
 *
 * - Logging: log_info, log_warn, log_error, log_step, _log_diagnostic
 * - Temp file management: track_temp_file, cleanup_temp_files, register_cleanup_trap
 * - SSH key helpers: generate_ssh_key_if_missing, get_ssh_fingerprint
 * - Env injection: inject_env_vars_ssh, inject_env_vars_local
 * - SSH key matching: check_ssh_key_by_fingerprint, ensure_ssh_key_with_provider
 *
 * These functions had zero test coverage despite being used across all cloud
 * provider scripts. Each test sources shared/common.sh and calls the function
 * in a real bash subprocess.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const envOpts = env
    ? { ...process.env, ...env }
    : process.env;
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}'`,
      {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
        env: envOpts as NodeJS.ProcessEnv,
      }
    );
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
 * Run a bash snippet capturing both stdout and stderr separately.
 */
function runBashWithStderr(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const envOpts = env
    ? { ...process.env, ...env }
    : process.env;
  try {
    const result = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}'`,
      {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
        env: envOpts as NodeJS.ProcessEnv,
      }
    );
    return { exitCode: 0, stdout: (result || "").trim(), stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || "").trim(),
    };
  }
}

/** Create a temporary directory for test files. */
function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ══════════════════════════════════════════════════════════════════════════
// Logging functions
// ══════════════════════════════════════════════════════════════════════════

describe("log_info", () => {
  it("should write to stderr (not stdout)", () => {
    const result = runBash(`log_info "hello info" 2>/dev/null; echo "stdout-only"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("stdout-only");
  });

  it("should include the message text in stderr", () => {
    // Redirect stderr to stdout so we can capture it
    const result = runBash(`log_info "test message here" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test message here");
  });

  it("should include green ANSI escape code", () => {
    const result = runBash(`log_info "green text" 2>&1`);
    expect(result.exitCode).toBe(0);
    // Green = \033[0;32m
    expect(result.stdout).toContain("\x1b[0;32m");
  });

  it("should include reset ANSI escape code", () => {
    const result = runBash(`log_info "colored" 2>&1`);
    expect(result.exitCode).toBe(0);
    // Reset = \033[0m
    expect(result.stdout).toContain("\x1b[0m");
  });
});

describe("log_warn", () => {
  it("should write to stderr", () => {
    const result = runBash(`log_warn "warning" 2>/dev/null; echo "ok"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("should include the message text", () => {
    const result = runBash(`log_warn "something wrong" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("something wrong");
  });

  it("should include yellow ANSI escape code", () => {
    const result = runBash(`log_warn "yellow text" 2>&1`);
    expect(result.exitCode).toBe(0);
    // Yellow = \033[1;33m
    expect(result.stdout).toContain("\x1b[1;33m");
  });
});

describe("log_error", () => {
  it("should write to stderr", () => {
    const result = runBash(`log_error "bad thing" 2>/dev/null; echo "ok"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("should include the message text", () => {
    const result = runBash(`log_error "fatal error" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fatal error");
  });

  it("should include red ANSI escape code", () => {
    const result = runBash(`log_error "red text" 2>&1`);
    expect(result.exitCode).toBe(0);
    // Red = \033[0;31m
    expect(result.stdout).toContain("\x1b[0;31m");
  });
});

describe("log_step", () => {
  it("should write to stderr", () => {
    const result = runBash(`log_step "step msg" 2>/dev/null; echo "ok"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("should include the message text", () => {
    const result = runBash(`log_step "provisioning" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provisioning");
  });

  it("should include cyan ANSI escape code", () => {
    const result = runBash(`log_step "cyan text" 2>&1`);
    expect(result.exitCode).toBe(0);
    // Cyan = \033[0;36m
    expect(result.stdout).toContain("\x1b[0;36m");
  });
});

describe("_log_diagnostic", () => {
  it("should print header, causes, and fixes", () => {
    const result = runBash(`
      _log_diagnostic "Something failed" \\
        "Bad credentials" \\
        "Network unreachable" \\
        "---" \\
        "Check your API key" \\
        "Check your internet" \\
        2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Something failed");
    expect(result.stdout).toContain("Possible causes:");
    expect(result.stdout).toContain("Bad credentials");
    expect(result.stdout).toContain("Network unreachable");
    expect(result.stdout).toContain("How to fix:");
    expect(result.stdout).toContain("Check your API key");
    expect(result.stdout).toContain("Check your internet");
  });

  it("should number the fix steps", () => {
    const result = runBash(`
      _log_diagnostic "Error" \\
        "cause" \\
        "---" \\
        "first fix" \\
        "second fix" \\
        "third fix" \\
        2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1. first fix");
    expect(result.stdout).toContain("2. second fix");
    expect(result.stdout).toContain("3. third fix");
  });

  it("should handle single cause and single fix", () => {
    const result = runBash(`
      _log_diagnostic "Timeout" "Server unresponsive" "---" "Retry later" 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Timeout");
    expect(result.stdout).toContain("Server unresponsive");
    expect(result.stdout).toContain("1. Retry later");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Temp file management
// ══════════════════════════════════════════════════════════════════════════

describe("track_temp_file", () => {
  it("should add file to CLEANUP_TEMP_FILES array", () => {
    const result = runBash(`
      track_temp_file "/tmp/test-file-1"
      track_temp_file "/tmp/test-file-2"
      echo "\${#CLEANUP_TEMP_FILES[@]}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2");
  });

  it("should store the exact path provided", () => {
    const result = runBash(`
      track_temp_file "/tmp/my-special-file.txt"
      echo "\${CLEANUP_TEMP_FILES[0]}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/tmp/my-special-file.txt");
  });

  it("should allow tracking multiple files in sequence", () => {
    const result = runBash(`
      track_temp_file "/tmp/a"
      track_temp_file "/tmp/b"
      track_temp_file "/tmp/c"
      for f in "\${CLEANUP_TEMP_FILES[@]}"; do echo "\$f"; done
    `);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"]);
  });
});

describe("cleanup_temp_files", () => {
  it("should remove tracked temp files", () => {
    const dir = createTempDir();
    const file1 = join(dir, "temp1.txt");
    const file2 = join(dir, "temp2.txt");
    writeFileSync(file1, "secret1");
    writeFileSync(file2, "secret2");

    const result = runBash(`
      track_temp_file "${file1}"
      track_temp_file "${file2}"
      cleanup_temp_files
      if [[ -f "${file1}" ]]; then echo "file1-exists"; else echo "file1-gone"; fi
      if [[ -f "${file2}" ]]; then echo "file2-exists"; else echo "file2-gone"; fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("file1-gone");
    expect(result.stdout).toContain("file2-gone");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not fail if tracked files do not exist", () => {
    const result = runBash(`
      track_temp_file "/tmp/nonexistent-spawn-test-file-${Date.now()}"
      cleanup_temp_files
      echo "ok"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("should not fail when no files are tracked", () => {
    const result = runBash(`
      cleanup_temp_files
      echo "ok"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("should preserve the exit code of the calling context", () => {
    // cleanup_temp_files captures $? and returns it
    const result = runBash(`
      track_temp_file "/tmp/nonexistent-${Date.now()}"
      (exit 42)
      cleanup_temp_files
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("exit=42");
  });
});

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
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should register TERM trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p TERM
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should cleanup tracked files on EXIT", () => {
    const dir = createTempDir();
    const file = join(dir, "auto-cleanup.txt");
    writeFileSync(file, "should be cleaned");

    // Run in a subshell that exits, triggering the trap
    runBash(`
      register_cleanup_trap
      track_temp_file "${file}"
      exit 0
    `);

    // File should have been cleaned up by the EXIT trap
    expect(existsSync(file)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SSH key helpers
// ══════════════════════════════════════════════════════════════════════════

describe("generate_ssh_key_if_missing", () => {
  it("should generate a new SSH key when file does not exist", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "test_key");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(keyPath + ".pub")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not overwrite an existing SSH key", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "existing_key");
    writeFileSync(keyPath, "existing-private-key-content");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}" 2>&1`);
    expect(result.exitCode).toBe(0);
    // Original content should be preserved
    expect(readFileSync(keyPath, "utf-8")).toBe("existing-private-key-content");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "nested", "deep", "test_key");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate an ed25519 key", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "ed25519_key");

    runBash(`generate_ssh_key_if_missing "${keyPath}" 2>&1`);
    const pubContent = readFileSync(keyPath + ".pub", "utf-8");
    expect(pubContent).toContain("ssh-ed25519");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate a key with no passphrase", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "nopass_key");

    const result = runBash(`
      generate_ssh_key_if_missing "${keyPath}" 2>&1
      # Try to read the key - should not prompt for passphrase
      ssh-keygen -y -f "${keyPath}" > /dev/null 2>&1
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exit=0");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("get_ssh_fingerprint", () => {
  it("should return an MD5 fingerprint string", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "fp_key");

    // Generate a key first
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    // MD5 fingerprint format: xx:xx:xx:xx:...
    expect(result.stdout).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2})+$/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not include the MD5: prefix", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "fp_key2");

    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("MD5:");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should produce consistent fingerprints for the same key", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "consistent_key");

    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result1 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    const result2 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result1.stdout).toBe(result2.stdout);
    expect(result1.stdout.length).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should produce different fingerprints for different keys", () => {
    const dir = createTempDir();
    const key1 = join(dir, "key1");
    const key2 = join(dir, "key2");

    runBash(`ssh-keygen -t ed25519 -f "${key1}" -N "" -q 2>&1`);
    runBash(`ssh-keygen -t ed25519 -f "${key2}" -N "" -q 2>&1`);

    const fp1 = runBash(`get_ssh_fingerprint "${key1}.pub"`);
    const fp2 = runBash(`get_ssh_fingerprint "${key2}.pub"`);
    expect(fp1.stdout).not.toBe(fp2.stdout);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Env injection helpers
// ══════════════════════════════════════════════════════════════════════════

describe("inject_env_vars_ssh", () => {
  it("should call upload and run functions with correct arguments", () => {
    const dir = createTempDir();

    const result = runBash(`
      register_cleanup_trap
      uploaded_args=""
      run_args=""
      mock_upload() { uploaded_args="$*"; }
      mock_run() { run_args="$*"; }
      inject_env_vars_ssh "1.2.3.4" mock_upload mock_run "KEY1=val1" "KEY2=val2"
      echo "upload: \${uploaded_args}"
      echo "run: \${run_args}"
    `);
    expect(result.exitCode).toBe(0);
    // Upload should receive: server_ip, local_temp_path, /tmp/env_config
    expect(result.stdout).toContain("upload: 1.2.3.4");
    expect(result.stdout).toContain("/tmp/env_config");
    // Run should receive: server_ip, "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
    expect(result.stdout).toContain("run: 1.2.3.4");
    expect(result.stdout).toContain("cat /tmp/env_config >> ~/.zshrc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create a temp file with env config content", () => {
    const result = runBash(`
      register_cleanup_trap
      captured_content=""
      mock_upload() {
        # $2 is the local temp file path
        captured_content=$(cat "\$2")
      }
      mock_run() { :; }
      inject_env_vars_ssh "1.2.3.4" mock_upload mock_run "MY_KEY=my_value"
      echo "\${captured_content}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export MY_KEY=");
    expect(result.stdout).toContain("my_value");
  });

  it("should track the temp file for cleanup", () => {
    const result = runBash(`
      register_cleanup_trap
      mock_upload() { :; }
      mock_run() { :; }
      inject_env_vars_ssh "1.2.3.4" mock_upload mock_run "K=V"
      echo "\${#CLEANUP_TEMP_FILES[@]}"
    `);
    expect(result.exitCode).toBe(0);
    expect(parseInt(result.stdout)).toBeGreaterThanOrEqual(1);
  });
});

describe("inject_env_vars_local", () => {
  it("should call upload and run functions without server_ip", () => {
    const result = runBash(`
      register_cleanup_trap
      uploaded_args=""
      run_args=""
      mock_upload() { uploaded_args="$*"; }
      mock_run() { run_args="$*"; }
      inject_env_vars_local mock_upload mock_run "KEY1=val1"
      echo "upload: \${uploaded_args}"
      echo "run: \${run_args}"
    `);
    expect(result.exitCode).toBe(0);
    // Upload should receive: local_temp_path, /tmp/env_config (no server_ip)
    expect(result.stdout).toContain("upload:");
    expect(result.stdout).toContain("/tmp/env_config");
    // Run should receive: command (no server_ip)
    expect(result.stdout).toContain("run: cat /tmp/env_config >> ~/.zshrc");
  });

  it("should handle multiple env vars", () => {
    const result = runBash(`
      register_cleanup_trap
      captured_content=""
      mock_upload() { captured_content=$(cat "\$1"); }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "A=1" "B=2" "C=3"
      echo "\${captured_content}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export A=");
    expect(result.stdout).toContain("export B=");
    expect(result.stdout).toContain("export C=");
  });

  it("should track the temp file for cleanup", () => {
    const result = runBash(`
      register_cleanup_trap
      mock_upload() { :; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "K=V"
      echo "\${#CLEANUP_TEMP_FILES[@]}"
    `);
    expect(result.exitCode).toBe(0);
    expect(parseInt(result.stdout)).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SSH key matching
// ══════════════════════════════════════════════════════════════════════════

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys": [{"id": 1, "fingerprint": "ab:cd:ef:12:34"}]}'; }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "ab:cd:ef:12:34"
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exit=0");
  });

  it("should return non-zero when fingerprint is not found", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys": [{"id": 1, "fingerprint": "ab:cd:ef:12:34"}]}'; }
      if check_ssh_key_by_fingerprint mock_api "/ssh_keys" "xx:yy:zz:11:22"; then
        echo "found"
      else
        echo "not-found"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("not-found");
  });

  it("should return non-zero when API returns empty list", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys": []}'; }
      if check_ssh_key_by_fingerprint mock_api "/ssh_keys" "ab:cd:ef"; then
        echo "found"
      else
        echo "not-found"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("not-found");
  });

  it("should pass the endpoint argument to the API function", () => {
    const dir = createTempDir();
    const argsFile = join(dir, "captured_args.txt");

    const result = runBash(`
      mock_api() { echo "$*" > "${argsFile}"; echo '{"data": "fp-match"}'; }
      check_ssh_key_by_fingerprint mock_api "/my/endpoint" "fp-match"
    `);
    expect(result.exitCode).toBe(0);
    const capturedArgs = readFileSync(argsFile, "utf-8").trim();
    expect(capturedArgs).toContain("GET");
    expect(capturedArgs).toContain("/my/endpoint");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ensure_ssh_key_with_provider", () => {
  it("should skip registration when check callback returns 0 (key exists)", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "existing_provider_key");

    // Pre-generate a key
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`
      mock_check() { return 0; }
      mock_register() { echo "SHOULD-NOT-BE-CALLED"; return 0; }
      ensure_ssh_key_with_provider mock_check mock_register "TestCloud" "${keyPath}" 2>&1
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("SHOULD-NOT-BE-CALLED");
    expect(result.stdout).toContain("already registered");
    expect(result.stdout).toContain("exit=0");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should call register callback when check returns non-zero (key not found)", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "new_provider_key");

    // Pre-generate a key
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`
      mock_check() { return 1; }
      registered_name=""
      mock_register() { registered_name="\$1"; return 0; }
      ensure_ssh_key_with_provider mock_check mock_register "TestCloud" "${keyPath}" 2>&1
      echo "registered=\${registered_name}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registered=spawn-");
    expect(result.stdout).toContain("Registering SSH key with TestCloud");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when register callback fails", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "fail_key");

    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`
      mock_check() { return 1; }
      mock_register() { return 1; }
      if ensure_ssh_key_with_provider mock_check mock_register "FailCloud" "${keyPath}" 2>/dev/null; then
        echo "success"
      else
        echo "failed"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("failed");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate key if it does not exist", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "auto_gen_key");

    expect(existsSync(keyPath)).toBe(false);

    const result = runBash(`
      mock_check() { return 0; }
      mock_register() { return 0; }
      ensure_ssh_key_with_provider mock_check mock_register "AutoGen" "${keyPath}" 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(keyPath + ".pub")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should pass fingerprint and pub key path to check callback", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "cb_args_key");

    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`
      check_args=""
      mock_check() { check_args="$*"; return 0; }
      mock_register() { return 0; }
      ensure_ssh_key_with_provider mock_check mock_register "ArgCheck" "${keyPath}" 2>/dev/null
      echo "\${check_args}"
    `);
    expect(result.exitCode).toBe(0);
    // Should receive fingerprint (colon-separated hex) and pub key path
    expect(result.stdout).toMatch(/[0-9a-f]{2}(:[0-9a-f]{2})+/);
    expect(result.stdout).toContain(keyPath + ".pub");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should pass key name and pub key path to register callback", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "reg_args_key");

    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`
      reg_args=""
      mock_check() { return 1; }
      mock_register() { reg_args="$*"; return 0; }
      ensure_ssh_key_with_provider mock_check mock_register "RegArgs" "${keyPath}" 2>/dev/null
      echo "\${reg_args}"
    `);
    expect(result.exitCode).toBe(0);
    // Should have key name starting with "spawn-" and pub key path
    expect(result.stdout).toContain("spawn-");
    expect(result.stdout).toContain(keyPath + ".pub");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should use default key path when not specified", () => {
    // This test checks the default path is $HOME/.ssh/id_ed25519
    // We can't test the full flow without affecting real SSH keys,
    // so we verify the default argument logic
    const result = runBash(`
      mock_check() {
        # The second argument should be the pub key path
        if [[ "\$2" == *"/.ssh/id_ed25519.pub" ]]; then
          echo "default-path-used"
        fi
        return 0
      }
      mock_register() { return 0; }
      # Only pass 3 args (no key_path), should default to $HOME/.ssh/id_ed25519
      ensure_ssh_key_with_provider mock_check mock_register "DefaultPath" 2>/dev/null
      # Note: this may fail on CI without $HOME/.ssh/id_ed25519, but the check_callback
      # will at least be called with the right path
    `);
    // We check that default path is used (the echo from mock_check goes to stdout)
    // This may generate a key if none exists, which is fine
    expect(result.stdout).toContain("default-path-used");
  });

  it("should show provider name in log messages", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "log_key");

    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q 2>&1`);

    const result = runBash(`
      mock_check() { return 0; }
      mock_register() { return 0; }
      ensure_ssh_key_with_provider mock_check mock_register "MyProvider" "${keyPath}" 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MyProvider");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// check_python_available
// ══════════════════════════════════════════════════════════════════════════

describe("check_python_available", () => {
  it("should succeed when python3 is available", () => {
    const result = runBash(`check_python_available`);
    expect(result.exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// POLL_INTERVAL configuration
// ══════════════════════════════════════════════════════════════════════════

describe("POLL_INTERVAL", () => {
  it("should default to 1 when SPAWN_POLL_INTERVAL is not set", () => {
    const result = runBash(`echo "\${POLL_INTERVAL}"`, {
      SPAWN_POLL_INTERVAL: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1");
  });

  it("should respect SPAWN_POLL_INTERVAL when set", () => {
    const result = runBash(`echo "\${POLL_INTERVAL}"`, {
      SPAWN_POLL_INTERVAL: "0.1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0.1");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// SSH_OPTS defaults
// ══════════════════════════════════════════════════════════════════════════

describe("SSH_OPTS", () => {
  it("should set default SSH options when SSH_OPTS is not pre-set", () => {
    const result = runBash(`echo "\${SSH_OPTS}"`, { SSH_OPTS: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("StrictHostKeyChecking=no");
    expect(result.stdout).toContain("UserKnownHostsFile=/dev/null");
    expect(result.stdout).toContain("LogLevel=ERROR");
    expect(result.stdout).toContain("id_ed25519");
  });

  it("should not override SSH_OPTS when already set", () => {
    const result = runBash(`echo "\${SSH_OPTS}"`, {
      SSH_OPTS: "-o CustomOption=yes",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("-o CustomOption=yes");
  });
});
