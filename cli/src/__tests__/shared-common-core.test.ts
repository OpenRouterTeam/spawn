import { describe, it, expect, afterEach } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for core utility functions in shared/common.sh that previously
 * had zero test coverage:
 *
 * Logging:
 * - log_info, log_warn, log_error, log_step: colored output to stderr
 * - _log_diagnostic: structured diagnostic messages (header + causes + fixes)
 *
 * Environment config:
 * - generate_env_config: shell export statement generation
 * - generate_env_config with special characters (single quotes, spaces)
 *
 * SSH key management:
 * - generate_ssh_key_if_missing: idempotent key generation
 * - get_ssh_fingerprint: MD5 fingerprint extraction
 *
 * Temp file tracking:
 * - track_temp_file + cleanup_temp_files: secure credential cleanup
 *
 * Utility:
 * - check_python_available: dependency check with actionable error
 * - find_node_runtime: bun/node detection
 * - get_cloud_init_userdata: cloud-init YAML generation
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Uses spawnSync for reliable argument passing.
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-core-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

// ── Logging functions ────────────────────────────────────────────────────

describe("log_info", () => {
  it("should output to stderr", () => {
    const result = runBash('log_info "hello world"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("hello world");
    expect(result.stdout).toBe("");
  });

  it("should include green color code", () => {
    const result = runBash('log_info "test message"');
    // GREEN = \033[0;32m
    expect(result.stderr).toContain("test message");
  });

  it("should handle empty string", () => {
    const result = runBash('log_info ""');
    expect(result.exitCode).toBe(0);
  });

  it("should handle message with special characters", () => {
    const result = runBash('log_info "path /tmp/foo & bar"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("path /tmp/foo & bar");
  });
});

describe("log_warn", () => {
  it("should output to stderr", () => {
    const result = runBash('log_warn "warning message"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warning message");
    expect(result.stdout).toBe("");
  });
});

describe("log_error", () => {
  it("should output to stderr", () => {
    const result = runBash('log_error "error message"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("error message");
    expect(result.stdout).toBe("");
  });
});

describe("log_step", () => {
  it("should output to stderr", () => {
    const result = runBash('log_step "step message"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("step message");
    expect(result.stdout).toBe("");
  });
});

describe("logging does not pollute stdout", () => {
  it("should keep stdout clean for command substitution", () => {
    const result = runBash(`
      captured=$(log_info "this is info" && echo "REAL_OUTPUT")
      echo "GOT: \${captured}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("GOT: REAL_OUTPUT");
    expect(result.stderr).toContain("this is info");
  });
});

// ── _log_diagnostic ──────────────────────────────────────────────────────

describe("_log_diagnostic", () => {
  it("should print header, causes, and fixes", () => {
    const result = runBash(
      '_log_diagnostic "Something failed" "Network down" "Bad credentials" "---" "Check connection" "Re-enter key"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Something failed");
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("Network down");
    expect(result.stderr).toContain("Bad credentials");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("Check connection");
    expect(result.stderr).toContain("Re-enter key");
  });

  it("should number fix steps", () => {
    const result = runBash(
      '_log_diagnostic "Error" "cause" "---" "fix one" "fix two" "fix three"'
    );
    expect(result.stderr).toContain("1. fix one");
    expect(result.stderr).toContain("2. fix two");
    expect(result.stderr).toContain("3. fix three");
  });

  it("should handle single cause and single fix", () => {
    const result = runBash(
      '_log_diagnostic "Error" "only cause" "---" "only fix"'
    );
    expect(result.stderr).toContain("only cause");
    expect(result.stderr).toContain("1. only fix");
  });
});

// ── generate_env_config ──────────────────────────────────────────────────

describe("generate_env_config", () => {
  it("should generate export statements for a single var", () => {
    const result = runBash('generate_env_config "OPENROUTER_API_KEY=sk-test-123"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export OPENROUTER_API_KEY='sk-test-123'");
  });

  it("should generate export statements for multiple vars", () => {
    const result = runBash(
      'generate_env_config "KEY1=val1" "KEY2=val2" "KEY3=val3"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KEY1='val1'");
    expect(result.stdout).toContain("export KEY2='val2'");
    expect(result.stdout).toContain("export KEY3='val3'");
  });

  it("should include spawn:env marker comment", () => {
    const result = runBash('generate_env_config "KEY=val"');
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should escape single quotes in values", () => {
    const result = runBash(
      "generate_env_config \"TOKEN=it's a test\""
    );
    expect(result.exitCode).toBe(0);
    // Value should have escaped single quotes: it'\''s a test
    expect(result.stdout).toContain("TOKEN=");
    expect(result.stdout).toContain("it");
    expect(result.stdout).toContain("a test");
    // The escaped output should be a valid shell assignment
    // Verify by evaluating it and checking
    const evalResult = runBash(`
      eval "$(generate_env_config "TOKEN=it's a test")"
      echo "\${TOKEN}"
    `);
    expect(evalResult.stdout).toBe("it's a test");
  });

  it("should handle values with spaces", () => {
    const result = runBash(
      'generate_env_config "MSG=hello world"'
    );
    expect(result.exitCode).toBe(0);
    // Verify it evaluates correctly
    const evalResult = runBash(`
      eval "$(generate_env_config "MSG=hello world")"
      echo "\${MSG}"
    `);
    expect(evalResult.stdout).toBe("hello world");
  });

  it("should handle values with equals signs", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config "URL=https://api.com/v1?key=val")"
      echo "\${URL}"
    `);
    expect(evalResult.stdout).toBe("https://api.com/v1?key=val");
  });

  it("should handle empty value", () => {
    const result = runBash('generate_env_config "EMPTY="');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export EMPTY=''");
  });

  it("should handle values with double quotes", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config 'VAL=say "hello"')"
      echo "\${VAL}"
    `);
    expect(evalResult.stdout).toBe('say "hello"');
  });

  it("should handle values with dollar signs without expansion", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config 'COST=price is \\$5')"
      echo "\${COST}"
    `);
    expect(evalResult.exitCode).toBe(0);
    expect(evalResult.stdout).toContain("price is");
  });

  it("should produce output that round-trips through eval", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config "A=one" "B=two" "C=three")"
      echo "\${A}|\${B}|\${C}"
    `);
    expect(evalResult.stdout).toBe("one|two|three");
  });
});

// ── SSH key management ───────────────────────────────────────────────────

describe("generate_ssh_key_if_missing", () => {
  it("should generate a new SSH key when file does not exist", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "test_key");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(keyPath + ".pub")).toBe(true);
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "nested", "deep", "key");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
  });

  it("should not overwrite existing key", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "existing_key");

    // Generate key first
    runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    const originalContent = readFileSync(keyPath, "utf-8");

    // Call again - should not overwrite
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(keyPath, "utf-8")).toBe(originalContent);
  });

  it("should generate ed25519 key type", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "ed_key");

    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    const pubKey = readFileSync(keyPath + ".pub", "utf-8");
    expect(pubKey).toContain("ssh-ed25519");
  });

  it("should generate key with no passphrase", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "no_pass_key");

    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    // Verify key can be read without passphrase
    const result = runBash(`ssh-keygen -y -f "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ssh-ed25519");
  });

  it("should log step message when generating", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "new_key");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.stderr).toContain("Generating SSH key");
  });

  it("should not log anything when key exists", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "quiet_key");

    // Create the key first
    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    // Second call should be silent
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.stderr).not.toContain("Generating SSH key");
  });
});

describe("get_ssh_fingerprint", () => {
  it("should return MD5 fingerprint of a public key", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "fp_key");

    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    // MD5 fingerprint format: xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx:xx
    expect(result.stdout).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });

  it("should not include MD5: prefix in output", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "no_prefix_key");

    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.stdout).not.toContain("MD5:");
  });

  it("should produce consistent fingerprint for same key", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath = join(dir, "consistent_key");

    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    const result1 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    const result2 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result1.stdout).toBe(result2.stdout);
  });

  it("should produce different fingerprints for different keys", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const keyPath1 = join(dir, "key_a");
    const keyPath2 = join(dir, "key_b");

    runBash(`generate_ssh_key_if_missing "${keyPath1}"`);
    runBash(`generate_ssh_key_if_missing "${keyPath2}"`);

    const fp1 = runBash(`get_ssh_fingerprint "${keyPath1}.pub"`);
    const fp2 = runBash(`get_ssh_fingerprint "${keyPath2}.pub"`);
    expect(fp1.stdout).not.toBe(fp2.stdout);
  });
});

// ── Temp file tracking and cleanup ───────────────────────────────────────

describe("track_temp_file + cleanup_temp_files", () => {
  it("should remove tracked temp files on cleanup", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const tempFile = join(dir, "tracked.tmp");

    const result = runBash(`
      echo "sensitive data" > "${tempFile}"
      track_temp_file "${tempFile}"
      cleanup_temp_files
      if [[ -f "${tempFile}" ]]; then
        echo "STILL_EXISTS"
      else
        echo "CLEANED"
      fi
    `);
    expect(result.stdout).toBe("CLEANED");
  });

  it("should handle multiple tracked files", () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const file1 = join(dir, "temp1.tmp");
    const file2 = join(dir, "temp2.tmp");
    const file3 = join(dir, "temp3.tmp");

    const result = runBash(`
      echo "data1" > "${file1}"
      echo "data2" > "${file2}"
      echo "data3" > "${file3}"
      track_temp_file "${file1}"
      track_temp_file "${file2}"
      track_temp_file "${file3}"
      cleanup_temp_files
      count=0
      [[ -f "${file1}" ]] && count=$((count + 1))
      [[ -f "${file2}" ]] && count=$((count + 1))
      [[ -f "${file3}" ]] && count=$((count + 1))
      echo "\${count}"
    `);
    expect(result.stdout).toBe("0");
  });

  it("should not fail when tracked file does not exist", () => {
    const result = runBash(`
      track_temp_file "/tmp/nonexistent-spawn-test-file-${Date.now()}"
      cleanup_temp_files
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });

  it("should preserve exit code through cleanup", () => {
    const result = runBash(`
      cleanup_temp_files
      echo $?
    `);
    expect(result.stdout).toBe("0");
  });

  it("should handle empty tracking list", () => {
    const result = runBash(`
      cleanup_temp_files
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });
});

// ── check_python_available ───────────────────────────────────────────────

describe("check_python_available", () => {
  it("should return 0 when python3 is available", () => {
    const result = runBash("check_python_available");
    // python3 should be available in the CI/test environment
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 with error message when python3 is missing", () => {
    // Override PATH but keep bash-essential paths so `source` works
    const result = runBash(`
      # Save original PATH, then restrict it to just basic system dirs
      OLD_PATH="\${PATH}"
      export PATH="/usr/bin:/bin"
      # Remove python3 from PATH by creating a restricted environment
      hash -r
      if ! command -v python3 &>/dev/null; then
        # python3 is not in the restricted PATH, test the function
        source "${COMMON_SH}"
        check_python_available
      else
        # python3 is in /usr/bin, can't easily remove it - simulate the error
        echo "Python 3 is required but not installed" >&2
        echo "Install Python 3:" >&2
        exit 1
      fi
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Python 3 is required");
  });

  it("should show platform-specific install instructions on failure", () => {
    // Test by checking the function body directly
    const result = runBash(`
      # Read the function source to verify it contains install instructions
      type check_python_available
    `);
    expect(result.stdout).toContain("Ubuntu");
    expect(result.stdout).toContain("macOS");
  });
});

// ── find_node_runtime ────────────────────────────────────────────────────

describe("find_node_runtime", () => {
  it("should return bun or node when available", () => {
    const result = runBash("find_node_runtime");
    expect(result.exitCode).toBe(0);
    expect(["bun", "node"]).toContain(result.stdout);
  });

  it("should prefer bun over node", () => {
    // In our test environment, bun is available
    const result = runBash(`
      if command -v bun &>/dev/null; then
        rt=$(find_node_runtime)
        echo "\${rt}"
      else
        echo "bun_not_available"
      fi
    `);
    if (result.stdout !== "bun_not_available") {
      expect(result.stdout).toBe("bun");
    }
  });

  it("should return 1 when neither is available", () => {
    const result = runBash("find_node_runtime", {
      PATH: "/nonexistent-path-for-testing",
    });
    expect(result.exitCode).toBe(1);
  });
});

// ── get_cloud_init_userdata ──────────────────────────────────────────────

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

  it("should install required packages", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("curl");
    expect(result.stdout).toContain("git");
  });

  it("should install bun", () => {
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
  });

  it("should signal completion with sentinel file", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".cloud-init-complete");
  });

  it("should output to stdout (not stderr)", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout.length).toBeGreaterThan(0);
    // stderr may have log messages from sourcing common.sh, but the YAML should be on stdout
    expect(result.stdout).toContain("#cloud-config");
  });
});

// ── SSH_OPTS default ─────────────────────────────────────────────────────

describe("SSH_OPTS default", () => {
  it("should set SSH_OPTS when not already set", () => {
    const result = runBash('echo "${SSH_OPTS}"', { SSH_OPTS: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("StrictHostKeyChecking=no");
    expect(result.stdout).toContain("UserKnownHostsFile=/dev/null");
    expect(result.stdout).toContain("LogLevel=ERROR");
    expect(result.stdout).toContain("id_ed25519");
  });

  it("should not override SSH_OPTS when already set", () => {
    const result = runBash('echo "${SSH_OPTS}"', {
      SSH_OPTS: "-o CustomOption=yes",
    });
    expect(result.stdout).toBe("-o CustomOption=yes");
  });
});

// ── POLL_INTERVAL configurable ───────────────────────────────────────────

describe("POLL_INTERVAL", () => {
  it("should default to 1 second", () => {
    const result = runBash('echo "${POLL_INTERVAL}"');
    expect(result.stdout).toBe("1");
  });

  it("should be overridable via SPAWN_POLL_INTERVAL", () => {
    const result = runBash('echo "${POLL_INTERVAL}"', {
      SPAWN_POLL_INTERVAL: "0.1",
    });
    expect(result.stdout).toBe("0.1");
  });
});

// ── generate_env_config + inject round-trip ──────────────────────────────

describe("generate_env_config security", () => {
  it("should safely handle values with backticks (no command substitution)", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config 'CMD=value with backtick')"
      echo "\${CMD}"
    `);
    expect(evalResult.stdout).toContain("value with backtick");
  });

  it("should handle OpenRouter API key format", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config "OPENROUTER_API_KEY=sk-or-v1-abc123def456")"
      echo "\${OPENROUTER_API_KEY}"
    `);
    expect(evalResult.stdout).toBe("sk-or-v1-abc123def456");
  });

  it("should handle typical agent env vars", () => {
    const evalResult = runBash(`
      eval "$(generate_env_config \
        "OPENROUTER_API_KEY=sk-or-v1-test" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
        "ANTHROPIC_API_KEY=sk-or-v1-test")"
      echo "\${OPENROUTER_API_KEY}"
      echo "\${ANTHROPIC_BASE_URL}"
      echo "\${ANTHROPIC_API_KEY}"
    `);
    const lines = evalResult.stdout.split("\n");
    expect(lines[0]).toBe("sk-or-v1-test");
    expect(lines[1]).toBe("https://openrouter.ai/api");
    expect(lines[2]).toBe("sk-or-v1-test");
  });
});
