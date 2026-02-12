import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for untested bash helper functions in shared/common.sh:
 *
 * - inject_env_vars_ssh: env var injection for SSH-based clouds (PR #468)
 * - inject_env_vars_local: env var injection for local/container clouds (PR #468)
 * - check_ssh_key_by_fingerprint: SSH key existence check via API (PR #552)
 * - ensure_ssh_key_with_provider: generic SSH key registration flow (PR #552)
 * - execute_agent_non_interactive: non-interactive agent execution (PR #468)
 * - opencode_install_cmd: OpenCode install command generation (PR #535)
 * - wait_for_cloud_init: cloud-init wait wrapper
 *
 * These functions had zero test coverage despite being used across multiple
 * cloud provider scripts. Each test sources shared/common.sh and calls the
 * function in a real bash subprocess.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 * Uses a temp file to capture stderr even on success.
 */
function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const stderrFile = join(tmpdir(), `spawn-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  try {
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'  2>"${stderrFile}"`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, "utf-8") : "";
    try { rmSync(stderrFile); } catch {}
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, "utf-8") : (err.stderr || "");
    try { rmSync(stderrFile); } catch {}
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr: (typeof stderr === "string" ? stderr : "").trim(),
    };
  }
}

/**
 * Create a temporary directory for test files.
 */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── inject_env_vars_ssh ─────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should create temp file, call upload and run callbacks with correct args", () => {
    const dir = createTempDir();
    const logFile = join(dir, "calls.log");

    const result = runBash(`
      mock_upload() {
        echo "upload:$1:$2:$3" >> "${logFile}"
      }
      mock_run() {
        echo "run:$1:$2" >> "${logFile}"
      }
      inject_env_vars_ssh "10.0.0.1" "mock_upload" "mock_run" "API_KEY=sk-test" "BASE_URL=https://openrouter.ai"
    `);

    expect(result.exitCode).toBe(0);

    const calls = readFileSync(logFile, "utf-8").trim().split("\n");
    // upload should be called with: server_ip, temp_file_path, /tmp/env_config
    expect(calls[0]).toStartWith("upload:10.0.0.1:");
    expect(calls[0]).toEndWith(":/tmp/env_config");
    // run should be called with: server_ip, command to cat and append to .zshrc
    expect(calls[1]).toBe("run:10.0.0.1:cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate env config content with correct exports", () => {
    const dir = createTempDir();
    const contentFile = join(dir, "content.txt");

    const result = runBash(`
      mock_upload() {
        cp "$2" "${contentFile}"
      }
      mock_run() {
        :
      }
      inject_env_vars_ssh "1.2.3.4" "mock_upload" "mock_run" "MY_KEY=my_value" "OTHER=hello"
    `);

    expect(result.exitCode).toBe(0);
    const content = readFileSync(contentFile, "utf-8");
    expect(content).toContain("export MY_KEY='my_value'");
    expect(content).toContain("export OTHER='hello'");
    expect(content).toContain("# [spawn:env]");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle env values with special characters", () => {
    const dir = createTempDir();
    const contentFile = join(dir, "content.txt");

    const result = runBash(`
      mock_upload() {
        cp "$2" "${contentFile}"
      }
      mock_run() {
        :
      }
      inject_env_vars_ssh "1.2.3.4" "mock_upload" "mock_run" "URL=https://example.com?key=abc&foo=bar"
    `);

    expect(result.exitCode).toBe(0);
    const content = readFileSync(contentFile, "utf-8");
    expect(content).toContain("export URL='https://example.com?key=abc&foo=bar'");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should set temp file permissions to 600", () => {
    const dir = createTempDir();
    const permFile = join(dir, "perms.txt");

    const result = runBash(`
      mock_upload() {
        stat -c '%a' "$2" > "${permFile}" 2>/dev/null || stat -f '%Lp' "$2" > "${permFile}"
      }
      mock_run() {
        :
      }
      inject_env_vars_ssh "1.2.3.4" "mock_upload" "mock_run" "KEY=val"
    `);

    expect(result.exitCode).toBe(0);
    const perms = readFileSync(permFile, "utf-8").trim();
    expect(perms).toBe("600");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── inject_env_vars_local ───────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload and run callbacks without server_ip argument", () => {
    const dir = createTempDir();
    const logFile = join(dir, "calls.log");

    const result = runBash(`
      mock_upload() {
        echo "upload:$1:$2" >> "${logFile}"
      }
      mock_run() {
        echo "run:$1" >> "${logFile}"
      }
      inject_env_vars_local "mock_upload" "mock_run" "API_KEY=test123"
    `);

    expect(result.exitCode).toBe(0);

    const calls = readFileSync(logFile, "utf-8").trim().split("\n");
    // upload called with: temp_file_path, /tmp/env_config (no server_ip)
    expect(calls[0]).toEndWith(":/tmp/env_config");
    // run called with: command (no server_ip)
    expect(calls[1]).toBe("run:cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate env config with multiple key-value pairs", () => {
    const dir = createTempDir();
    const contentFile = join(dir, "content.txt");

    const result = runBash(`
      mock_upload() {
        cp "$1" "${contentFile}"
      }
      mock_run() {
        :
      }
      inject_env_vars_local "mock_upload" "mock_run" "KEY1=val1" "KEY2=val2" "KEY3=val3"
    `);

    expect(result.exitCode).toBe(0);
    const content = readFileSync(contentFile, "utf-8");
    expect(content).toContain("export KEY1='val1'");
    expect(content).toContain("export KEY2='val2'");
    expect(content).toContain("export KEY3='val3'");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle single env var", () => {
    const dir = createTempDir();
    const contentFile = join(dir, "content.txt");

    const result = runBash(`
      mock_upload() {
        cp "$1" "${contentFile}"
      }
      mock_run() {
        :
      }
      inject_env_vars_local "mock_upload" "mock_run" "SOLO_KEY=solo_val"
    `);

    expect(result.exitCode).toBe(0);
    const content = readFileSync(contentFile, "utf-8");
    expect(content).toContain("export SOLO_KEY='solo_val'");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── check_ssh_key_by_fingerprint ────────────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"id": 1, "fingerprint": "SHA256:abc123def456"}, {"id": 2, "fingerprint": "SHA256:xyz789"}]}'
      }
      check_ssh_key_by_fingerprint "mock_api" "/ssh-keys" "SHA256:abc123def456"
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when fingerprint is not found in API response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"id": 1, "fingerprint": "SHA256:abc123def456"}]}'
      }
      check_ssh_key_by_fingerprint "mock_api" "/ssh-keys" "SHA256:notfound999"
    `);

    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when API returns empty response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": []}'
      }
      check_ssh_key_by_fingerprint "mock_api" "/ssh-keys" "SHA256:abc123"
    `);

    expect(result.exitCode).toBe(1);
  });

  it("should pass correct method and endpoint to API function", () => {
    const dir = createTempDir();
    const logFile = join(dir, "api_calls.log");

    const result = runBash(`
      mock_api() {
        echo "method:$1 endpoint:$2" > "${logFile}"
        echo '{"ssh_keys": [{"fingerprint": "fp123"}]}'
      }
      check_ssh_key_by_fingerprint "mock_api" "/v2/ssh_keys" "fp123"
    `);

    expect(result.exitCode).toBe(0);
    const logged = readFileSync(logFile, "utf-8").trim();
    expect(logged).toBe("method:GET endpoint:/v2/ssh_keys");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle fingerprint with colons in it", () => {
    const result = runBash(`
      mock_api() {
        echo '{"keys": [{"fingerprint": "ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90"}]}'
      }
      check_ssh_key_by_fingerprint "mock_api" "/keys" "ab:cd:ef:12:34:56:78:90:ab:cd:ef:12:34:56:78:90"
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should match fingerprint as substring in response", () => {
    const result = runBash(`
      mock_api() {
        echo '"fingerprint": "SHA256:LongFingerprint123"'
      }
      check_ssh_key_by_fingerprint "mock_api" "/keys" "LongFingerprint123"
    `);

    expect(result.exitCode).toBe(0);
  });
});

// ── ensure_ssh_key_with_provider ────────────────────────────────────────────

describe("ensure_ssh_key_with_provider", () => {
  it("should skip registration when check callback returns 0 (key exists)", () => {
    const dir = createTempDir();
    const logFile = join(dir, "actions.log");

    const result = runBash(`
      # Create a real SSH key for testing
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_existing() {
        echo "check_called" >> "${logFile}"
        return 0  # Key exists
      }
      register_new() {
        echo "register_called" >> "${logFile}"
        return 0
      }
      ensure_ssh_key_with_provider "check_existing" "register_new" "TestCloud" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8").trim();
    expect(log).toBe("check_called");
    // register_new should NOT have been called
    expect(log).not.toContain("register_called");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should register key when check callback returns 1 (key not found)", () => {
    const dir = createTempDir();
    const logFile = join(dir, "actions.log");

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_missing() {
        echo "check_called" >> "${logFile}"
        return 1  # Key not found
      }
      register_key() {
        echo "register_called:key_name=$1:pub_path=$2" >> "${logFile}"
        return 0
      }
      ensure_ssh_key_with_provider "check_missing" "register_key" "TestCloud" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(log[0]).toBe("check_called");
    // register should have been called with key_name and pub_path
    expect(log[1]).toMatch(/^register_called:key_name=spawn-.*:pub_path=.*\.pub$/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when registration callback fails", () => {
    const dir = createTempDir();

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_missing() { return 1; }
      register_fail() { return 1; }
      ensure_ssh_key_with_provider "check_missing" "register_fail" "TestCloud" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate SSH key if it does not exist", () => {
    const dir = createTempDir();
    const keyPath = join(dir, "new_key");

    expect(existsSync(keyPath)).toBe(false);

    const result = runBash(`
      check_ok() { return 0; }
      register_ok() { return 0; }
      ensure_ssh_key_with_provider "check_ok" "register_ok" "TestCloud" "${keyPath}"
    `);

    expect(result.exitCode).toBe(0);
    // Key should have been generated
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(keyPath + ".pub")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should pass fingerprint and pub_path to check callback", () => {
    const dir = createTempDir();
    const logFile = join(dir, "check_args.log");

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_with_args() {
        echo "fp=$1" >> "${logFile}"
        echo "pub=$2" >> "${logFile}"
        return 0
      }
      register_unused() { return 0; }
      ensure_ssh_key_with_provider "check_with_args" "register_unused" "TestCloud" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8").trim().split("\n");
    // Fingerprint should be non-empty MD5 colon-separated hash (get_ssh_fingerprint uses -E md5)
    expect(log[0]).toMatch(/^fp=[0-9a-f]{2}:/);
    // Pub path should end in .pub
    expect(log[1]).toMatch(/\.pub$/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate key name with spawn prefix and hostname", () => {
    const dir = createTempDir();
    const logFile = join(dir, "key_name.log");

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_miss() { return 1; }
      register_log() {
        echo "$1" > "${logFile}"
        return 0
      }
      ensure_ssh_key_with_provider "check_miss" "register_log" "TestCloud" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(0);
    const keyName = readFileSync(logFile, "utf-8").trim();
    // Key name format: spawn-HOSTNAME-TIMESTAMP
    expect(keyName).toMatch(/^spawn-.+-\d+$/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should log appropriate messages for existing key", () => {
    const dir = createTempDir();

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_exists() { return 0; }
      register_unused() { return 0; }
      ensure_ssh_key_with_provider "check_exists" "register_unused" "MyProvider" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("SSH key already registered with MyProvider");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should log registration step message", () => {
    const dir = createTempDir();

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_miss() { return 1; }
      register_ok() { return 0; }
      ensure_ssh_key_with_provider "check_miss" "register_ok" "Hetzner" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Registering SSH key with Hetzner");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should log error message when registration fails", () => {
    const dir = createTempDir();

    const result = runBash(`
      KEY_PATH="${dir}/test_key"
      ssh-keygen -t ed25519 -f "\${KEY_PATH}" -N "" -q

      check_miss() { return 1; }
      register_fail() { return 1; }
      ensure_ssh_key_with_provider "check_miss" "register_fail" "DigitalOcean" "\${KEY_PATH}"
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to register SSH key with DigitalOcean");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── execute_agent_non_interactive ───────────────────────────────────────────

describe("execute_agent_non_interactive", () => {
  it("should call exec callback with agent command and prompt for generic SSH", () => {
    const dir = createTempDir();
    const logFile = join(dir, "exec.log");

    const result = runBash(`
      mock_ssh_exec() {
        echo "server=$1" >> "${logFile}"
        echo "cmd=$2" >> "${logFile}"
      }
      execute_agent_non_interactive "10.0.0.1" "aider" "-m" "Fix the bug" "mock_ssh_exec"
    `);

    expect(result.exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(log[0]).toBe("server=10.0.0.1");
    // Command should contain agent name and flags and escaped prompt
    expect(log[1]).toContain("aider");
    expect(log[1]).toContain("-m");
    expect(log[1]).toContain("source ~/.zshrc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should log non-interactive mode message", () => {
    const result = runBash(`
      mock_exec() { :; }
      execute_agent_non_interactive "server1" "claude" "-p" "Hello" "mock_exec"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("non-interactive mode");
  });

  it("should handle prompt with spaces", () => {
    const dir = createTempDir();
    const logFile = join(dir, "exec.log");

    const result = runBash(`
      mock_exec() {
        echo "$2" > "${logFile}"
      }
      execute_agent_non_interactive "server1" "aider" "-m" "Fix all linter errors in the project" "mock_exec"
    `);

    expect(result.exitCode).toBe(0);
    const cmd = readFileSync(logFile, "utf-8").trim();
    expect(cmd).toContain("aider");
    expect(cmd).toContain("-m");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should include agent name in log message", () => {
    const result = runBash(`
      mock_exec() { :; }
      execute_agent_non_interactive "s" "claude" "-p" "test" "mock_exec"
    `);

    expect(result.stderr).toContain("claude");
  });
});

// ── opencode_install_cmd ────────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should output a non-empty command string", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(50);
  });

  it("should include architecture detection logic", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("uname -m");
    expect(result.stdout).toContain("aarch64");
    expect(result.stdout).toContain("arm64");
  });

  it("should include OS detection logic", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("uname -s");
    expect(result.stdout).toContain("darwin");
  });

  it("should download from github releases", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("github.com/opencode-ai/opencode/releases");
  });

  it("should create bin directory at ~/.opencode/bin", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("$HOME/.opencode/bin");
  });

  it("should add to PATH in both bashrc and zshrc", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
  });

  it("should include curl download with -fsSL flags", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("curl -fsSL");
  });

  it("should clean up temp directory after install", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).toContain("rm -rf /tmp/opencode-install");
  });

  it("should output a single line (no newlines)", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.stdout).not.toContain("\n");
  });

  it("should produce valid shell syntax", () => {
    // Verify the generated command can be parsed by bash without errors
    const result = runBash(`
      cmd=$(opencode_install_cmd)
      bash -n <(echo "$cmd") 2>&1 || echo "SYNTAX_ERROR"
    `);
    expect(result.stdout).not.toContain("SYNTAX_ERROR");
  });
});

// ── wait_for_cloud_init ─────────────────────────────────────────────────────

describe("wait_for_cloud_init", () => {
  it("should call generic_ssh_wait with correct arguments", () => {
    // We can verify the function exists and calls generic_ssh_wait by
    // checking that it passes through the right parameters.
    // Since we can't actually SSH, we override generic_ssh_wait.
    const dir = createTempDir();
    const logFile = join(dir, "wait_args.log");

    const result = runBash(`
      # Override generic_ssh_wait to capture arguments
      generic_ssh_wait() {
        echo "user=$1" > "${logFile}"
        echo "ip=$2" >> "${logFile}"
        echo "opts=$3" >> "${logFile}"
        echo "cmd=$4" >> "${logFile}"
        echo "desc=$5" >> "${logFile}"
        echo "max=$6" >> "${logFile}"
        echo "interval=$7" >> "${logFile}"
      }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      wait_for_cloud_init "192.168.1.100"
    `);

    expect(result.exitCode).toBe(0);
    const args = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(args[0]).toBe("user=root");
    expect(args[1]).toBe("ip=192.168.1.100");
    expect(args[2]).toBe("opts=-o StrictHostKeyChecking=no");
    expect(args[3]).toBe("cmd=test -f /root/.cloud-init-complete");
    expect(args[4]).toBe("desc=cloud-init");
    expect(args[5]).toBe("max=60");
    expect(args[6]).toBe("interval=5");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should accept custom max_attempts parameter", () => {
    const dir = createTempDir();
    const logFile = join(dir, "wait_args.log");

    const result = runBash(`
      generic_ssh_wait() {
        echo "max=$6" > "${logFile}"
      }
      SSH_OPTS=""
      wait_for_cloud_init "10.0.0.1" 120
    `);

    expect(result.exitCode).toBe(0);
    const maxAttempts = readFileSync(logFile, "utf-8").trim();
    expect(maxAttempts).toBe("max=120");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should default max_attempts to 60 when not specified", () => {
    const dir = createTempDir();
    const logFile = join(dir, "wait_args.log");

    const result = runBash(`
      generic_ssh_wait() {
        echo "$6" > "${logFile}"
      }
      SSH_OPTS=""
      wait_for_cloud_init "10.0.0.1"
    `);

    expect(result.exitCode).toBe(0);
    const maxAttempts = readFileSync(logFile, "utf-8").trim();
    expect(maxAttempts).toBe("60");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── ssh_run_server / ssh_upload_file / ssh_interactive_session ───────────────

describe("ssh_run_server", () => {
  it("should construct correct SSH command with default user root", () => {
    // We test by setting SSH_OPTS to include a bad host so ssh fails fast,
    // but we can verify the command args via a mock
    const dir = createTempDir();
    const logFile = join(dir, "ssh_cmd.log");

    const result = runBash(`
      # Override ssh to capture args
      ssh() {
        echo "args:$*" > "${logFile}"
      }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_run_server "10.0.0.5" "echo hello"
    `);

    expect(result.exitCode).toBe(0);
    const cmd = readFileSync(logFile, "utf-8").trim();
    expect(cmd).toContain("-o StrictHostKeyChecking=no");
    expect(cmd).toContain("root@10.0.0.5");
    expect(cmd).toContain("echo hello");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should use SSH_USER when set", () => {
    const dir = createTempDir();
    const logFile = join(dir, "ssh_cmd.log");

    const result = runBash(`
      ssh() {
        echo "$*" > "${logFile}"
      }
      SSH_OPTS=""
      SSH_USER="ubuntu"
      ssh_run_server "10.0.0.5" "ls"
    `);

    expect(result.exitCode).toBe(0);
    const cmd = readFileSync(logFile, "utf-8").trim();
    expect(cmd).toContain("ubuntu@10.0.0.5");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ssh_upload_file", () => {
  it("should construct correct SCP command", () => {
    const dir = createTempDir();
    const logFile = join(dir, "scp_cmd.log");

    const result = runBash(`
      scp() {
        echo "args:$*" > "${logFile}"
      }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_upload_file "10.0.0.5" "/local/file.txt" "/remote/file.txt"
    `);

    expect(result.exitCode).toBe(0);
    const cmd = readFileSync(logFile, "utf-8").trim();
    expect(cmd).toContain("-o StrictHostKeyChecking=no");
    expect(cmd).toContain("/local/file.txt");
    expect(cmd).toContain("root@10.0.0.5:/remote/file.txt");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ssh_interactive_session", () => {
  it("should include -t flag for interactive session", () => {
    const dir = createTempDir();
    const logFile = join(dir, "ssh_cmd.log");

    const result = runBash(`
      ssh() {
        echo "args:$*" > "${logFile}"
      }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_interactive_session "10.0.0.5" "zsh"
    `);

    expect(result.exitCode).toBe(0);
    const cmd = readFileSync(logFile, "utf-8").trim();
    expect(cmd).toContain("-t");
    expect(cmd).toContain("root@10.0.0.5");
    expect(cmd).toContain("zsh");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── ssh_verify_connectivity ─────────────────────────────────────────────────

describe("ssh_verify_connectivity", () => {
  it("should call generic_ssh_wait with correct parameters", () => {
    const dir = createTempDir();
    const logFile = join(dir, "verify_args.log");

    const result = runBash(`
      generic_ssh_wait() {
        echo "user=$1" > "${logFile}"
        echo "ip=$2" >> "${logFile}"
        echo "cmd=$4" >> "${logFile}"
        echo "desc=$5" >> "${logFile}"
      }
      SSH_OPTS=""
      ssh_verify_connectivity "10.0.0.5"
    `);

    expect(result.exitCode).toBe(0);
    const args = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(args[0]).toBe("user=root");
    expect(args[1]).toBe("ip=10.0.0.5");
    expect(args[2]).toBe("cmd=echo ok");
    expect(args[3]).toBe("desc=SSH connectivity");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── track_temp_file / cleanup_temp_files ────────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  it("should clean up tracked temp files", () => {
    const dir = createTempDir();
    const tempFile1 = join(dir, "temp1.txt");
    const tempFile2 = join(dir, "temp2.txt");
    writeFileSync(tempFile1, "secret data 1");
    writeFileSync(tempFile2, "secret data 2");

    const result = runBash(`
      track_temp_file "${tempFile1}"
      track_temp_file "${tempFile2}"
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
    expect(existsSync(tempFile1)).toBe(false);
    expect(existsSync(tempFile2)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not fail when tracked file does not exist", () => {
    const result = runBash(`
      track_temp_file "/nonexistent/file/path.txt"
      cleanup_temp_files
    `);

    expect(result.exitCode).toBe(0);
  });

  it("should handle empty cleanup list", () => {
    const result = runBash("cleanup_temp_files");
    expect(result.exitCode).toBe(0);
  });
});
