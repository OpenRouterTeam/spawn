import { describe, it, expect } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for environment injection, temp file cleanup, SSH key management,
 * and non-interactive agent execution functions in shared/common.sh.
 *
 * These functions are used by EVERY cloud provider script but had zero
 * test coverage:
 *
 * - inject_env_vars_ssh: injects env vars into remote server shell config
 * - inject_env_vars_local: injects env vars for non-SSH providers
 * - track_temp_file / cleanup_temp_files: secure temp file lifecycle
 * - ensure_ssh_key_with_provider: SSH key registration flow
 * - check_ssh_key_by_fingerprint: SSH key existence check
 * - execute_agent_non_interactive: prompt-based agent execution
 *
 * Each test sources shared/common.sh and calls functions in a real bash
 * subprocess to catch actual shell behavior.
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
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

/**
 * Create a temporary directory for test files.
 */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── inject_env_vars_ssh ────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should generate env config, upload it, and append to .zshrc", () => {
    const dir = createTempDir();
    // Mock upload_file: copies src to the destination path
    // Mock run_server: executes the command locally
    const result = runBash(`
      mock_upload() {
        local server_ip="\$1"
        local src="\$2"
        local dst="\$3"
        cp "\$src" "\$dst"
      }
      mock_run() {
        local server_ip="\$1"
        shift
        eval "\$@"
      }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "MY_KEY=my_value" "OTHER=data"
      cat "${dir}/.zshrc"
    `);
    expect(result.exitCode).toBe(0);
    // .zshrc should contain the exported vars
    expect(result.stdout).toContain("export MY_KEY='my_value'");
    expect(result.stdout).toContain("export OTHER='data'");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should pass server_ip as first arg to upload and run functions", () => {
    const dir = createTempDir();
    const result = runBash(`
      captured_ip_upload=""
      captured_ip_run=""
      mock_upload() { captured_ip_upload="\$1"; cp "\$2" /dev/null; }
      mock_run() { captured_ip_run="\$1"; shift; }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_ssh "192.168.1.42" mock_upload mock_run "KEY=val"
      echo "upload_ip=\$captured_ip_upload"
      echo "run_ip=\$captured_ip_run"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("upload_ip=192.168.1.42");
    expect(result.stdout).toContain("run_ip=192.168.1.42");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle special characters in env values", () => {
    const dir = createTempDir();
    const result = runBash(`
      mock_upload() { cp "\$2" "\$3"; }
      mock_run() { shift; eval "\$@"; }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "API_URL=https://example.com?key=abc&foo=bar"
      cat "${dir}/.zshrc"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export API_URL=");
    expect(result.stdout).toContain("https://example.com?key=abc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create temp file with restricted permissions (600)", () => {
    const dir = createTempDir();
    const result = runBash(`
      last_uploaded_src=""
      mock_upload() {
        last_uploaded_src="\$2"
        cp "\$2" "\$3"
      }
      mock_run() { shift; eval "\$@"; }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY=val"
      # Check permissions of the temp file (should be 600)
      if [[ -f "\$last_uploaded_src" ]]; then
        perms=\$(stat -c '%a' "\$last_uploaded_src" 2>/dev/null || stat -f '%Lp' "\$last_uploaded_src" 2>/dev/null)
        echo "perms=\$perms"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("perms=600");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── inject_env_vars_local ──────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should inject env vars without server_ip parameter", () => {
    const dir = createTempDir();
    const result = runBash(`
      mock_upload_local() {
        local src="\$1"
        local dst="\$2"
        cp "\$src" "\$dst"
      }
      mock_run_local() {
        eval "\$@"
      }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_local mock_upload_local mock_run_local "LOCAL_KEY=local_val"
      cat "${dir}/.zshrc"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export LOCAL_KEY='local_val'");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle multiple env vars for local injection", () => {
    const dir = createTempDir();
    const result = runBash(`
      mock_upload_local() { cp "\$1" "\$2"; }
      mock_run_local() { eval "\$@"; }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_local mock_upload_local mock_run_local \
        "OPENROUTER_API_KEY=sk-or-v1-abc" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
        "OPENAI_API_KEY=sk-or-v1-abc"
      cat "${dir}/.zshrc"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export OPENROUTER_API_KEY='sk-or-v1-abc'");
    expect(result.stdout).toContain("export ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
    expect(result.stdout).toContain("export OPENAI_API_KEY='sk-or-v1-abc'");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not pass server_ip to upload or run functions", () => {
    const dir = createTempDir();
    const result = runBash(`
      captured_args_upload=""
      captured_args_run=""
      mock_upload_local() {
        captured_args_upload="\$#"
        cp "\$1" /dev/null
      }
      mock_run_local() {
        captured_args_run="\$#"
      }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_local mock_upload_local mock_run_local "KEY=val"
      echo "upload_argc=\$captured_args_upload"
      echo "run_argc=\$captured_args_run"
    `);
    expect(result.exitCode).toBe(0);
    // upload should get 2 args (src, dst), not 3 (ip, src, dst)
    expect(result.stdout).toContain("upload_argc=2");
    // run should get 1 arg (command), not 2 (ip, command)
    expect(result.stdout).toContain("run_argc=1");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── track_temp_file / cleanup_temp_files ───────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  it("should track and clean up a single temp file", () => {
    const dir = createTempDir();
    const tempFile = join(dir, "secret.tmp");
    writeFileSync(tempFile, "sensitive-data");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      cleanup_temp_files
      if [[ -f "${tempFile}" ]]; then
        echo "file_exists=true"
      else
        echo "file_exists=false"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("file_exists=false");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should track and clean up multiple temp files", () => {
    const dir = createTempDir();
    const files = ["a.tmp", "b.tmp", "c.tmp"].map(f => join(dir, f));
    files.forEach(f => writeFileSync(f, "data"));

    const trackCmds = files.map(f => `track_temp_file "${f}"`).join("\n");
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      ${trackCmds}
      cleanup_temp_files
      remaining=0
      for f in ${files.map(f => `"${f}"`).join(" ")}; do
        if [[ -f "\$f" ]]; then remaining=\$((remaining + 1)); fi
      done
      echo "remaining=\$remaining"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("remaining=0");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not error when cleaning up non-existent files", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "/tmp/nonexistent-file-xyz-12345"
      cleanup_temp_files
      echo "ok"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("should preserve exit code through cleanup", () => {
    // cleanup_temp_files should return the original exit code
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      # Simulate a function that sets exit code then cleans up
      (exit 42)
      cleanup_temp_files
      echo "exit_code=\$?"
    `);
    expect(result.stdout).toContain("exit_code=42");
  });

  it("should handle empty CLEANUP_TEMP_FILES array", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      cleanup_temp_files
      echo "ok"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("should clean up files created by inject_env_vars_ssh", () => {
    const dir = createTempDir();
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { cp "\$2" "${dir}/uploaded"; }
      mock_run() { shift; }
      export HOME="${dir}"
      touch "${dir}/.zshrc"
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY=val"
      # At this point CLEANUP_TEMP_FILES should have one entry
      echo "tracked_count=\${#CLEANUP_TEMP_FILES[@]}"
      # Verify the tracked file exists before cleanup
      if [[ -f "\${CLEANUP_TEMP_FILES[0]}" ]]; then echo "before_cleanup=exists"; fi
      cleanup_temp_files
      if [[ -f "\${CLEANUP_TEMP_FILES[0]}" ]]; then echo "after_cleanup=exists"; else echo "after_cleanup=gone"; fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tracked_count=1");
    expect(result.stdout).toContain("before_cleanup=exists");
    expect(result.stdout).toContain("after_cleanup=gone");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── ensure_ssh_key_with_provider ───────────────────────────────────────

describe("ensure_ssh_key_with_provider", () => {
  it("should skip registration when key is already registered", () => {
    const dir = createTempDir();
    // Create a fake SSH key pair
    const keyPath = join(dir, "id_ed25519");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result = runBash(`
      check_callback() {
        echo "check called" >&2
        return 0  # Key already exists
      }
      register_callback() {
        echo "register called" >&2
        return 0
      }
      ensure_ssh_key_with_provider check_callback register_callback "TestProvider" "${keyPath}"
    `);
    expect(result.exitCode).toBe(0);
    // Should have called check but NOT register
    expect(result.stderr).toContain("check called");
    expect(result.stderr).not.toContain("register called");
    expect(result.stderr).toContain("SSH key already registered with TestProvider");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should register key when not already registered", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "id_ed25519");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result = runBash(`
      check_callback() {
        return 1  # Key does not exist
      }
      register_callback() {
        echo "registered with name=\$1" >&2
        return 0
      }
      ensure_ssh_key_with_provider check_callback register_callback "TestProvider" "${keyPath}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("registered with name=spawn-");
    expect(result.stderr).toContain("SSH key registered with TestProvider");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return failure when registration fails", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "id_ed25519");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result = runBash(`
      check_callback() { return 1; }
      register_callback() { return 1; }
      ensure_ssh_key_with_provider check_callback register_callback "TestProvider" "${keyPath}"
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to register SSH key with TestProvider");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate SSH key if missing", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "new_key");

    const result = runBash(`
      check_callback() { return 0; }  # Pretend key is registered
      register_callback() { return 0; }
      ensure_ssh_key_with_provider check_callback register_callback "TestProvider" "${keyPath}"
      if [[ -f "${keyPath}" ]]; then echo "key_generated=true"; fi
      if [[ -f "${keyPath}.pub" ]]; then echo "pub_generated=true"; fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("key_generated=true");
    expect(result.stdout).toContain("pub_generated=true");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should pass fingerprint to check callback", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "id_ed25519");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result = runBash(`
      check_callback() {
        echo "fingerprint=\$1" >&2
        return 0
      }
      register_callback() { return 0; }
      ensure_ssh_key_with_provider check_callback register_callback "TestProvider" "${keyPath}"
    `);
    expect(result.exitCode).toBe(0);
    // Fingerprint should be an MD5 hash (colon-separated hex)
    expect(result.stderr).toMatch(/fingerprint=[0-9a-f]{2}(:[0-9a-f]{2})+/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should pass pub key path to check callback", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "id_ed25519");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result = runBash(`
      check_callback() {
        echo "pub_path=\$2" >&2
        return 0
      }
      register_callback() { return 0; }
      ensure_ssh_key_with_provider check_callback register_callback "TestProvider" "${keyPath}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`pub_path=${keyPath}.pub`);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── check_ssh_key_by_fingerprint ───────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"fingerprint": "SHA256:abc123def456"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh-keys" "SHA256:abc123def456"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when fingerprint is not found", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"fingerprint": "SHA256:other"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh-keys" "SHA256:abc123def456"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when API returns empty response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": []}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh-keys" "SHA256:abc123def456"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should pass correct method and endpoint to API function", () => {
    const result = runBash(`
      mock_api() {
        echo "method=\$1 endpoint=\$2" >&2
        echo '{"ssh_keys": []}'
      }
      check_ssh_key_by_fingerprint mock_api "/v2/ssh-keys" "SHA256:test" 2>&1 >/dev/null
    `);
    // The function calls api_func GET endpoint
    expect(result.stdout).toContain("method=GET");
    expect(result.stdout).toContain("endpoint=/v2/ssh-keys");
  });
});

// ── execute_agent_non_interactive ──────────────────────────────────────

describe("execute_agent_non_interactive", () => {
  it("should use sprite exec for sprite-based callbacks", () => {
    const result = runBash(`
      # Mock sprite command to capture the call
      sprite() {
        echo "sprite_called=true"
        echo "args=\$@"
      }
      export HOME="/tmp"
      execute_agent_non_interactive "my-sprite" "claude" "-p" "Fix the bug" "sprite_exec"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sprite_called=true");
    expect(result.stdout).toContain("exec");
    expect(result.stdout).toContain("my-sprite");
  });

  it("should use generic callback for non-sprite execution", () => {
    const result = runBash(`
      mock_ssh_exec() {
        echo "ssh_exec_called=true"
        echo "server=\$1"
        echo "cmd=\$2"
      }
      execute_agent_non_interactive "10.0.0.1" "aider" "-m" "Add tests" "mock_ssh_exec"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ssh_exec_called=true");
    expect(result.stdout).toContain("server=10.0.0.1");
    // The command should contain the agent and prompt
    expect(result.stdout).toContain("aider");
  });

  it("should include agent flags in the command", () => {
    const result = runBash(`
      mock_exec() {
        echo "cmd=\$2"
      }
      execute_agent_non_interactive "server" "claude" "--dangerously-skip-permissions -p" "Hello" "mock_exec"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dangerously-skip-permissions -p");
  });

  it("should source .zshrc before running the agent", () => {
    const result = runBash(`
      mock_exec() {
        echo "cmd=\$2"
      }
      execute_agent_non_interactive "server" "claude" "-p" "test prompt" "mock_exec"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source ~/.zshrc");
  });
});

// ── generate_ssh_key_if_missing ────────────────────────────────────────

describe("generate_ssh_key_if_missing", () => {
  it("should generate a key when it does not exist", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "test_key");

    const result = runBash(`
      generate_ssh_key_if_missing "${keyPath}"
      if [[ -f "${keyPath}" ]]; then echo "key_exists=true"; fi
      if [[ -f "${keyPath}.pub" ]]; then echo "pub_exists=true"; fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("key_exists=true");
    expect(result.stdout).toContain("pub_exists=true");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not overwrite an existing key", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "existing_key");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    // Record original fingerprint
    const origFingerprint = execSync(`ssh-keygen -lf "${keyPath}.pub"`, { encoding: "utf-8" }).trim();

    const result = runBash(`
      generate_ssh_key_if_missing "${keyPath}"
      echo "done"
    `);
    expect(result.exitCode).toBe(0);

    // Fingerprint should be unchanged
    const newFingerprint = execSync(`ssh-keygen -lf "${keyPath}.pub"`, { encoding: "utf-8" }).trim();
    expect(newFingerprint).toBe(origFingerprint);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── get_ssh_fingerprint ────────────────────────────────────────────────

describe("get_ssh_fingerprint", () => {
  it("should return the MD5 fingerprint of a public key", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "fp_key");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    // The function uses -E md5 and strips "MD5:" prefix, giving colon-separated hex
    expect(result.stdout).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2})+$/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should produce consistent fingerprints for the same key", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "fp_key2");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, { timeout: 10000 });

    const result1 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    const result2 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result1.stdout).toBe(result2.stdout);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should produce different fingerprints for different keys", () => {
    const dir = createTempDir();
    const key1 = join(dir, "key1");
    const key2 = join(dir, "key2");
    execSync(`ssh-keygen -t ed25519 -f "${key1}" -N "" -q`, { timeout: 10000 });
    execSync(`ssh-keygen -t ed25519 -f "${key2}" -N "" -q`, { timeout: 10000 });

    const fp1 = runBash(`get_ssh_fingerprint "${key1}.pub"`);
    const fp2 = runBash(`get_ssh_fingerprint "${key2}.pub"`);
    expect(fp1.stdout).not.toBe(fp2.stdout);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── register_cleanup_trap ──────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should set EXIT trap", () => {
    const result = runBash(`
      trap -p EXIT
    `);
    expect(result.exitCode).toBe(0);
    // The trap should contain cleanup_temp_files
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should set INT trap", () => {
    const result = runBash(`
      trap -p INT
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should set TERM trap", () => {
    const result = runBash(`
      trap -p TERM
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });
});

// ── opencode_install_cmd ───────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should output a valid bash command string", () => {
    const result = runBash(`opencode_install_cmd`);
    expect(result.exitCode).toBe(0);
    // Should contain architecture detection
    expect(result.stdout).toContain("uname -m");
    expect(result.stdout).toContain("uname -s");
    // Should download from GitHub
    expect(result.stdout).toContain("github.com/opencode-ai/opencode");
    // Should set up PATH
    expect(result.stdout).toContain(".opencode/bin");
  });

  it("should produce syntactically valid bash", () => {
    const result = runBash(`
      CMD=$(opencode_install_cmd)
      bash -n -c "\$CMD" 2>&1
      echo "syntax_valid=\$?"
    `);
    // bash -n checks syntax without executing
    expect(result.stdout).toContain("syntax_valid=0");
  });
});

// ── SSH configuration constants ────────────────────────────────────────

describe("SSH_OPTS", () => {
  it("should be defined after sourcing common.sh", () => {
    const result = runBash(`echo "\$SSH_OPTS"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("StrictHostKeyChecking=no");
    expect(result.stdout).toContain("UserKnownHostsFile=/dev/null");
  });

  it("should include LogLevel=ERROR to suppress warnings", () => {
    const result = runBash(`echo "\$SSH_OPTS"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LogLevel=ERROR");
  });

  it("should include the default SSH key path", () => {
    const result = runBash(`echo "\$SSH_OPTS"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-i");
    expect(result.stdout).toContain("id_ed25519");
  });
});
