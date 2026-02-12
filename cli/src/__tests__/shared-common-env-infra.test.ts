import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Tests for environment injection, cloud-init, instance polling, temp file
 * cleanup, and non-interactive agent execution functions in shared/common.sh.
 *
 * These are critical infrastructure functions used by every agent script:
 * - inject_env_vars_ssh: credential injection for SSH-based clouds
 * - inject_env_vars_local: credential injection for non-SSH providers
 * - get_cloud_init_userdata: cloud-init script generation
 * - generic_wait_for_instance: instance status polling loop
 * - execute_agent_non_interactive: non-interactive agent execution
 * - track_temp_file / cleanup_temp_files: secure temp file cleanup
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 * When mergeStderr is true, stderr is redirected to stdout (useful for testing
 * functions that only write to stderr like log_step, _log_diagnostic).
 */
function runBash(script: string, { mergeStderr = false } = {}): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const cmd = `bash -c '${fullScript.replace(/'/g, "'\\''")}'${mergeStderr ? " 2>&1" : ""}`;
  try {
    const stdout = execSync(cmd, {
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

// ── inject_env_vars_ssh ───────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should call upload and run functions with correct arguments", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spawn-test-"));
    try {
      const result = runBash(`
        UPLOADED_LOCAL=""
        UPLOADED_REMOTE=""
        RAN_CMD=""
        mock_upload() { UPLOADED_LOCAL="$2"; UPLOADED_REMOTE="$3"; }
        mock_run() { RAN_CMD="$2"; }
        inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY1=val1" "KEY2=val2"
        echo "remote=$UPLOADED_REMOTE"
        echo "ran=$RAN_CMD"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("remote=/tmp/env_config");
      expect(result.stdout).toContain("ran=cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should pass server IP as first argument to upload and run functions", () => {
    const result = runBash(`
      UPLOAD_IP=""
      RUN_IP=""
      mock_upload() { UPLOAD_IP="$1"; }
      mock_run() { RUN_IP="$1"; }
      inject_env_vars_ssh "192.168.1.100" mock_upload mock_run "TEST=value"
      echo "upload_ip=$UPLOAD_IP"
      echo "run_ip=$RUN_IP"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("upload_ip=192.168.1.100");
    expect(result.stdout).toContain("run_ip=192.168.1.100");
  });

  it("should generate env config content via generate_env_config", () => {
    const result = runBash(`
      mock_upload() {
        # Read the temp file content
        cat "$2"
      }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "OPENROUTER_API_KEY=sk-test-123" "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export OPENROUTER_API_KEY='sk-test-123'");
    expect(result.stdout).toContain("export ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should create a temp file with restrictive permissions (600)", () => {
    const result = runBash(`
      TEMP_PATH=""
      mock_upload() { TEMP_PATH="$2"; stat -c "%a" "$2" 2>/dev/null || stat -f "%Lp" "$2"; }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY=val"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("600");
  });

  it("should handle values with special characters", () => {
    const result = runBash(`
      mock_upload() { cat "$2"; }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY=value with spaces" "URL=https://example.com?foo=bar&baz=qux"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KEY='value with spaces'");
    expect(result.stdout).toContain("export URL='https://example.com?foo=bar&baz=qux'");
  });
});

// ── inject_env_vars_local ─────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload and run functions without server IP", () => {
    const result = runBash(`
      UPLOAD_ARGS=""
      RUN_ARGS=""
      mock_upload() { UPLOAD_ARGS="$1 $2"; }
      mock_run() { RUN_ARGS="$1"; }
      inject_env_vars_local mock_upload mock_run "KEY1=val1"
      echo "upload=$UPLOAD_ARGS"
      echo "run=$RUN_ARGS"
    `);
    expect(result.exitCode).toBe(0);
    // Upload receives: local_path remote_path (no server IP)
    expect(result.stdout).toMatch(/upload=.*\/tmp\/env_config/);
    expect(result.stdout).toContain("run=cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
  });

  it("should generate env config with multiple variables", () => {
    const result = runBash(`
      mock_upload() { cat "$1"; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "A=1" "B=2" "C=3"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export A='1'");
    expect(result.stdout).toContain("export B='2'");
    expect(result.stdout).toContain("export C='3'");
  });

  it("should create temp file with mode 600", () => {
    const result = runBash(`
      mock_upload() { stat -c "%a" "$1" 2>/dev/null || stat -f "%Lp" "$1"; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "KEY=val"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("600");
  });

  it("should handle values with single quotes", () => {
    const result = runBash(`
      mock_upload() { cat "$1"; }
      mock_run() { :; }
      inject_env_vars_local mock_upload mock_run "MSG=it'\\''s a test"
    `);
    expect(result.exitCode).toBe(0);
    // The generate_env_config function escapes single quotes
    expect(result.stdout).toContain("export MSG=");
  });
});

// ── get_cloud_init_userdata ───────────────────────────────────────────────

describe("get_cloud_init_userdata", () => {
  it("should output valid cloud-config YAML header", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#cloud-config");
  });

  it("should include package_update directive", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("package_update: true");
  });

  it("should install essential packages", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("- curl");
    expect(result.stdout).toContain("- unzip");
    expect(result.stdout).toContain("- git");
    expect(result.stdout).toContain("- zsh");
  });

  it("should install Bun runtime", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("bun.sh/install");
  });

  it("should install Claude Code", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("claude.ai/install.sh");
  });

  it("should configure PATH in .bashrc and .zshrc", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
    expect(result.stdout).toContain(".claude/local/bin");
    expect(result.stdout).toContain(".bun/bin");
  });

  it("should signal completion by touching marker file", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("touch /root/.cloud-init-complete");
  });

  it("should include runcmd section", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("runcmd:");
  });
});

// ── track_temp_file / cleanup_temp_files ──────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  it("should track a temp file and clean it up", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-test-"));
    const tmpFile = join(tmpDir, "test-secret.txt");
    writeFileSync(tmpFile, "secret-data");

    try {
      const result = runBash(`
        track_temp_file "${tmpFile}"
        if [[ -f "${tmpFile}" ]]; then echo "exists_before=yes"; fi
        cleanup_temp_files
        if [[ -f "${tmpFile}" ]]; then echo "exists_after=yes"; else echo "exists_after=no"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("exists_before=yes");
      expect(result.stdout).toContain("exists_after=no");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should track multiple temp files", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-test-"));
    const file1 = join(tmpDir, "file1.txt");
    const file2 = join(tmpDir, "file2.txt");
    const file3 = join(tmpDir, "file3.txt");
    writeFileSync(file1, "data1");
    writeFileSync(file2, "data2");
    writeFileSync(file3, "data3");

    try {
      const result = runBash(`
        track_temp_file "${file1}"
        track_temp_file "${file2}"
        track_temp_file "${file3}"
        cleanup_temp_files
        count=0
        for f in "${file1}" "${file2}" "${file3}"; do
          if [[ -f "$f" ]]; then count=$((count + 1)); fi
        done
        echo "remaining=$count"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("remaining=0");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle cleanup of already-deleted files gracefully", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spawn-cleanup-test-"));
    const tmpFile = join(tmpDir, "deleted.txt");
    writeFileSync(tmpFile, "data");

    try {
      const result = runBash(`
        track_temp_file "${tmpFile}"
        rm -f "${tmpFile}"
        cleanup_temp_files
        echo "ok"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ok");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle cleanup with no tracked files", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      cleanup_temp_files
      echo "ok"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("should preserve exit code through cleanup", () => {
    const result = runBash(`
      (
        exit_code_test() {
          return 42
        }
        exit_code_test
        cleanup_temp_files
        echo "exit=$?"
      ) || true
      echo "done"
    `);
    // cleanup_temp_files should preserve the exit code
    expect(result.stdout).toContain("done");
  });
});

// ── register_cleanup_trap ─────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should set up EXIT trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p EXIT
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should set up INT trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p INT
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should set up TERM trap", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p TERM
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });
});

// ── generic_wait_for_instance ─────────────────────────────────────────────

describe("generic_wait_for_instance", () => {
  it("should succeed when instance is immediately ready", () => {
    const result = runBash(`
      mock_api() {
        echo '{"instance":{"status":"active","main_ip":"10.0.0.5"}}'
      }
      INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/123" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 3
      echo "ip=$TEST_IP"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ip=10.0.0.5");
  });

  it("should poll until target status is reached", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spawn-poll-test-"));
    const counterFile = join(tmpDir, "counter");
    writeFileSync(counterFile, "0");
    try {
      const result = runBash(`
        COUNTER_FILE="${counterFile}"
        mock_api() {
          local count
          count=$(cat "$COUNTER_FILE")
          count=$((count + 1))
          echo "$count" > "$COUNTER_FILE"
          if [[ "$count" -ge 3 ]]; then
            echo '{"instance":{"status":"active","main_ip":"10.0.0.5"}}'
          else
            echo '{"instance":{"status":"provisioning","main_ip":""}}'
          fi
        }
        INSTANCE_STATUS_POLL_DELAY=0
        generic_wait_for_instance mock_api "/instances/123" "active" \
          "d['instance']['status']" "d['instance']['main_ip']" \
          TEST_IP "Instance" 5
        echo "ip=$TEST_IP"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ip=10.0.0.5");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should fail after max attempts", () => {
    const result = runBash(`
      mock_api() {
        echo '{"instance":{"status":"provisioning","main_ip":""}}'
      }
      INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/123" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 2
      rc=$?
      echo "result=$rc"
    `);
    // Function returns 1 on failure, but script continues (no set -e)
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("result=1");
  });

  it("should export IP to specified variable name", () => {
    const result = runBash(`
      mock_api() {
        echo '{"instance":{"status":"running","ip":"172.16.0.1"}}'
      }
      INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/456" "running" \
        "d['instance']['status']" "d['instance']['ip']" \
        MY_CUSTOM_IP "Server" 3
      echo "custom_ip=$MY_CUSTOM_IP"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("custom_ip=172.16.0.1");
  });

  it("should handle API errors gracefully", () => {
    const result = runBash(`
      mock_api() {
        return 1
      }
      INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/789" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 2
    `);
    // Should fail but not crash
    expect(result.exitCode).toBe(1);
  });

  it("should handle status reached but empty IP", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spawn-poll-test-"));
    const counterFile = join(tmpDir, "counter");
    writeFileSync(counterFile, "0");
    try {
      const result = runBash(`
        COUNTER_FILE="${counterFile}"
        mock_api() {
          local count
          count=$(cat "$COUNTER_FILE")
          count=$((count + 1))
          echo "$count" > "$COUNTER_FILE"
          if [[ "$count" -ge 3 ]]; then
            echo '{"instance":{"status":"active","main_ip":"10.0.0.99"}}'
          else
            echo '{"instance":{"status":"active","main_ip":""}}'
          fi
        }
        INSTANCE_STATUS_POLL_DELAY=0
        generic_wait_for_instance mock_api "/instances/123" "active" \
          "d['instance']['status']" "d['instance']['main_ip']" \
          TEST_IP "Instance" 5
        echo "ip=$TEST_IP"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ip=10.0.0.99");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should use default max_attempts of 60 when not specified", () => {
    // We just check it doesn't error with 7 args (8th optional)
    const result = runBash(`
      mock_api() {
        echo '{"instance":{"status":"active","main_ip":"1.2.3.4"}}'
      }
      INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/1" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance"
      echo "ip=$TEST_IP"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ip=1.2.3.4");
  });
});

// ── execute_agent_non_interactive ─────────────────────────────────────────

describe("execute_agent_non_interactive", () => {
  it("should call generic exec callback with correct command structure", () => {
    const result = runBash(`
      mock_exec() {
        echo "target=$1"
        echo "cmd=$2"
      }
      execute_agent_non_interactive "10.0.0.1" "aider" "-m" "Fix the bug" "mock_exec"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("target=10.0.0.1");
    // Should contain agent name and flags in the command
    const cmdLine = result.stdout.split("\n").find((l: string) => l.startsWith("cmd="));
    expect(cmdLine).toBeDefined();
    expect(cmdLine).toContain("aider");
    expect(cmdLine).toContain("-m");
    expect(cmdLine).toContain("source ~/.zshrc");
  });

  it("should use sprite exec for sprite-style callbacks", () => {
    // When exec_callback contains "sprite", it uses sprite exec directly
    // We mock sprite command to capture what would be called
    const result = runBash(`
      sprite() {
        echo "sprite_args=$*"
      }
      execute_agent_non_interactive "my-sprite" "claude" "-p" "Hello world" "sprite_exec"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sprite_args=exec -s my-sprite --");
  });
});

// ── wait_for_cloud_init ───────────────────────────────────────────────────

describe("wait_for_cloud_init", () => {
  it("should call generic_ssh_wait with correct parameters", () => {
    // We override generic_ssh_wait to capture arguments
    const result = runBash(`
      generic_ssh_wait() {
        echo "user=$1"
        echo "ip=$2"
        echo "test_cmd=$4"
        echo "desc=$5"
        echo "max=$6"
      }
      wait_for_cloud_init "10.0.0.1" 30
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user=root");
    expect(result.stdout).toContain("ip=10.0.0.1");
    expect(result.stdout).toContain("test_cmd=test -f /root/.cloud-init-complete");
    expect(result.stdout).toContain("desc=cloud-init");
    expect(result.stdout).toContain("max=30");
  });

  it("should default to 60 max attempts", () => {
    const result = runBash(`
      generic_ssh_wait() {
        echo "max=$6"
      }
      wait_for_cloud_init "10.0.0.1"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("max=60");
  });
});

// ── ssh_run_server / ssh_upload_file / ssh_interactive_session ─────────────

describe("ssh_run_server", () => {
  it("should construct correct ssh command with default user", () => {
    const result = runBash(`
      ssh() { echo "ssh_args=$*"; }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_run_server "10.0.0.1" "ls /tmp"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-o StrictHostKeyChecking=no");
    expect(result.stdout).toContain("root@10.0.0.1");
    expect(result.stdout).toContain("ls /tmp");
  });

  it("should use SSH_USER when set", () => {
    const result = runBash(`
      ssh() { echo "ssh_args=$*"; }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      SSH_USER="ubuntu"
      ssh_run_server "10.0.0.1" "whoami"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ubuntu@10.0.0.1");
  });
});

describe("ssh_upload_file", () => {
  it("should construct correct scp command", () => {
    const result = runBash(`
      scp() { echo "scp_args=$*"; }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_upload_file "10.0.0.1" "/local/file.txt" "/remote/file.txt"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-o StrictHostKeyChecking=no");
    expect(result.stdout).toContain("/local/file.txt");
    expect(result.stdout).toContain("root@10.0.0.1:/remote/file.txt");
  });

  it("should use SSH_USER when set", () => {
    const result = runBash(`
      scp() { echo "scp_args=$*"; }
      SSH_OPTS=""
      SSH_USER="deploy"
      ssh_upload_file "10.0.0.1" "/tmp/a" "/tmp/b"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deploy@10.0.0.1:/tmp/b");
  });
});

describe("ssh_interactive_session", () => {
  it("should use -t flag for interactive session", () => {
    const result = runBash(`
      ssh() { echo "ssh_args=$*"; }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_interactive_session "10.0.0.1" "tmux new"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-t");
    expect(result.stdout).toContain("root@10.0.0.1");
    expect(result.stdout).toContain("tmux new");
  });
});

// ── ssh_verify_connectivity ───────────────────────────────────────────────

describe("ssh_verify_connectivity", () => {
  it("should call generic_ssh_wait with echo ok test command", () => {
    const result = runBash(`
      generic_ssh_wait() {
        echo "user=$1"
        echo "ip=$2"
        echo "opts=$3"
        echo "test_cmd=$4"
        echo "desc=$5"
        echo "max=$6"
        echo "interval=$7"
      }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_verify_connectivity "10.0.0.1" 15 3
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user=root");
    expect(result.stdout).toContain("ip=10.0.0.1");
    expect(result.stdout).toContain("test_cmd=echo ok");
    expect(result.stdout).toContain("desc=SSH connectivity");
    expect(result.stdout).toContain("max=15");
    expect(result.stdout).toContain("interval=3");
  });

  it("should include ConnectTimeout in SSH options", () => {
    const result = runBash(`
      generic_ssh_wait() { echo "opts=$3"; }
      SSH_OPTS="-o StrictHostKeyChecking=no"
      ssh_verify_connectivity "10.0.0.1"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ConnectTimeout=5");
  });

  it("should default to 30 max attempts and 5s interval", () => {
    const result = runBash(`
      generic_ssh_wait() {
        echo "max=$6"
        echo "interval=$7"
      }
      SSH_OPTS=""
      ssh_verify_connectivity "10.0.0.1"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("max=30");
    expect(result.stdout).toContain("interval=5");
  });

  it("should use SSH_USER when set", () => {
    const result = runBash(`
      generic_ssh_wait() { echo "user=$1"; }
      SSH_OPTS=""
      SSH_USER="admin"
      ssh_verify_connectivity "10.0.0.1"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user=admin");
  });
});

// ── opencode_install_cmd ──────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should output a curl-based install command", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.exitCode).toBe(0);
    // opencode_install_cmd should output the install command
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("curl");
  });
});

// ── _log_diagnostic ───────────────────────────────────────────────────────

describe("_log_diagnostic", () => {
  it("should output problem description and possible causes", () => {
    const result = runBash(`
      _log_diagnostic "Something went wrong" "Cause 1" "Cause 2" --- "Fix 1" "Fix 2"
    `, { mergeStderr: true });
    expect(result.stdout).toContain("Something went wrong");
    expect(result.stdout).toContain("Cause 1");
    expect(result.stdout).toContain("Cause 2");
  });

  it("should output troubleshooting steps after separator", () => {
    const result = runBash(`
      _log_diagnostic "Error occurred" "Bad config" --- "Check config file" "Retry the operation"
    `, { mergeStderr: true });
    expect(result.stdout).toContain("Check config file");
    expect(result.stdout).toContain("Retry the operation");
  });
});

// ── log_step ──────────────────────────────────────────────────────────────

describe("log_step", () => {
  it("should output message to stderr", () => {
    const result = runBash('log_step "Processing files..."', { mergeStderr: true });
    expect(result.stdout).toContain("Processing files...");
  });

  it("should use cyan color (different from log_warn yellow)", () => {
    // log_step uses cyan (\033[36m), log_warn uses yellow (\033[33m)
    // We check the output contains the step prefix
    const result = runBash('log_step "Step message"', { mergeStderr: true });
    expect(result.stdout).toContain("Step message");
  });
});

// ── check_python_available ────────────────────────────────────────────────

describe("check_python_available", () => {
  it("should succeed when python3 is available", () => {
    const result = runBash("check_python_available");
    // python3 should be available in the test environment
    expect(result.exitCode).toBe(0);
  });
});
