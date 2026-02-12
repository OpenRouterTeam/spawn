import { describe, it, expect } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management and env injection functions in shared/common.sh.
 *
 * These functions had zero test coverage despite being security-critical:
 *
 * Credential management:
 * - _load_token_from_env: loads API token from environment variable
 * - _load_token_from_config: loads API token from JSON config file
 * - _validate_token_with_provider: validates token with provider API
 * - _save_token_to_config: saves API token to JSON config file with json_escape
 * - _multi_creds_all_env_set: checks if all env vars in a list are set
 * - _multi_creds_validate: validates multi-credentials with test function
 *
 * Env injection:
 * - inject_env_vars_ssh: injects env vars into remote server via SSH
 * - inject_env_vars_local: injects env vars for non-SSH providers
 *
 * Temp file cleanup:
 * - track_temp_file: registers a temp file for cleanup
 * - cleanup_temp_files: removes tracked temp files (shred or rm)
 * - register_cleanup_trap: sets up EXIT/INT/TERM trap for cleanup
 *
 * Retry helpers:
 * - calculate_retry_backoff: exponential backoff with jitter
 * - _update_retry_interval: interval doubling with cap
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
  const { spawnSync } = require("child_process");
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
 * Create a unique temporary directory for test files.
 */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _load_token_from_env ────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export MY_TOKEN="test-token-123"
      _load_token_from_env "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should log that it is using the env var", () => {
    const result = runBash(`
      export MY_TOKEN="test-token-123"
      _load_token_from_env "MY_TOKEN" "TestProvider" 2>&1
    `);
    expect(result.stdout).toContain("TestProvider");
    expect(result.stdout).toContain("environment");
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_env "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export MY_TOKEN=""
      _load_token_from_env "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should handle env var names with underscores", () => {
    const result = runBash(`
      export LONG_PROVIDER_API_KEY="abc123"
      _load_token_from_env "LONG_PROVIDER_API_KEY" "LongProvider"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _load_token_from_config ──────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from config file with api_key field", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "my-secret-key" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("my-secret-key");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should load token from config file with token field", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "token-value-456" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("token-value-456");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should prefer api_key over token when both present", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "preferred", token: "fallback" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("preferred");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/tmp/nonexistent-config-$(date +%s).json" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has empty api_key", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file has invalid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "not valid json{{{");

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file has no api_key or token fields", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ username: "user", password: "pass" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should export the loaded token as the specified env var", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "exported-key" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" "CUSTOM_VAR_NAME" "TestProvider"
      echo "$CUSTOM_VAR_NAME"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exported-key");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _validate_token_with_provider ────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when test function is empty (no validation)", () => {
    const result = runBash(`
      _validate_token_with_provider "" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_func() { return 0; }
      export MY_TOKEN="valid-token"
      _validate_token_with_provider "test_func" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_func() { return 1; }
      export MY_TOKEN="invalid-token"
      _validate_token_with_provider "test_func" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset env var when validation fails", () => {
    const result = runBash(
      'test_func() { return 1; }\n' +
      'export MY_TOKEN="invalid-token"\n' +
      '_validate_token_with_provider "test_func" "MY_TOKEN" "TestProvider" 2>/dev/null\n' +
      'echo "TOKEN_IS_SET=${MY_TOKEN:-UNSET}"'
    );
    expect(result.stdout).toContain("TOKEN_IS_SET=UNSET");
  });

  it("should log error message when validation fails", () => {
    const result = runBash(`
      test_func() { return 1; }
      export MY_TOKEN="bad-token"
      _validate_token_with_provider "test_func" "MY_TOKEN" "TestProvider" 2>&1
    `);
    expect(result.stdout).toContain("Authentication failed");
    expect(result.stdout).toContain("TestProvider");
  });
});

// ── _save_token_to_config ────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("should create config file with token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "subdir", "config.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "my-secret-token"
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.api_key).toBe("my-secret-token");
    expect(content.token).toBe("my-secret-token");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should set file permissions to 600", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "secret"`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const configFile = join(dir, "deep", "nested", "config.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "token-value"
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should properly escape special characters in token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" 'token"with"quotes'`);

    const raw = readFileSync(configFile, "utf-8");
    const content = JSON.parse(raw);
    expect(content.api_key).toBe('token"with"quotes');

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle token with backslashes", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" 'token\\with\\backslashes'`);

    const raw = readFileSync(configFile, "utf-8");
    const content = JSON.parse(raw);
    expect(content.api_key).toBe("token\\with\\backslashes");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should write valid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "test-token"`);

    const raw = readFileSync(configFile, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _multi_creds_all_env_set ─────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(`
      export VAR_A="value1"
      export VAR_B="value2"
      _multi_creds_all_env_set "VAR_A" "VAR_B"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when one env var is missing", () => {
    const result = runBash(`
      export VAR_A="value1"
      unset VAR_B 2>/dev/null
      _multi_creds_all_env_set "VAR_A" "VAR_B"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when one env var is empty", () => {
    const result = runBash(`
      export VAR_A="value1"
      export VAR_B=""
      _multi_creds_all_env_set "VAR_A" "VAR_B"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 for single env var that is set", () => {
    const result = runBash(`
      export SINGLE_VAR="present"
      _multi_creds_all_env_set "SINGLE_VAR"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when all env vars are missing", () => {
    const result = runBash(`
      unset VAR_X 2>/dev/null
      unset VAR_Y 2>/dev/null
      _multi_creds_all_env_set "VAR_X" "VAR_Y"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should handle three env vars", () => {
    const result = runBash(`
      export V1="a"
      export V2="b"
      export V3="c"
      _multi_creds_all_env_set "V1" "V2" "V3"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _multi_creds_validate ────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when test function is empty", () => {
    const result = runBash(`
      _multi_creds_validate "" "TestProvider" "VAR_A" "VAR_B"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_creds() { return 0; }
      _multi_creds_validate "test_creds" "TestProvider" "VAR_A" "VAR_B"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 and unset env vars when test function fails", () => {
    const result = runBash(`
      test_creds() { return 1; }
      export VAR_A="secret1"
      export VAR_B="secret2"
      _multi_creds_validate "test_creds" "TestProvider" "VAR_A" "VAR_B" 2>/dev/null
      validate_result=$?
      echo "A=\${VAR_A:-UNSET} B=\${VAR_B:-UNSET}"
      exit $validate_result
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("A=UNSET");
    expect(result.stdout).toContain("B=UNSET");
  });

  it("should log error when validation fails", () => {
    const result = runBash(`
      test_creds() { return 1; }
      _multi_creds_validate "test_creds" "MyProvider" "V1" 2>&1
    `);
    expect(result.stdout).toContain("Invalid");
    expect(result.stdout).toContain("MyProvider");
  });
});

// ── inject_env_vars_ssh ──────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should create temp file and call upload and run functions", () => {
    const dir = createTempDir();
    const logFile = join(dir, "calls.log");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { echo "UPLOAD:$1:$2:$3" >> "${logFile}"; }
      mock_run() { echo "RUN:$1:$2" >> "${logFile}"; }
      inject_env_vars_ssh "192.168.1.1" "mock_upload" "mock_run" \
        "API_KEY=test123" "BASE_URL=https://example.com"
    `);
    expect(result.exitCode).toBe(0);

    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("UPLOAD:192.168.1.1:");
    expect(log).toContain("/tmp/env_config");
    expect(log).toContain("RUN:192.168.1.1:");
    expect(log).toContain(".zshrc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate env config with correct exports", () => {
    const dir = createTempDir();
    const captureFile = join(dir, "captured_env.sh");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { cp "$2" "${captureFile}"; }
      mock_run() { :; }
      inject_env_vars_ssh "10.0.0.1" "mock_upload" "mock_run" \
        "MY_KEY=my_value" "OTHER=value2"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(captureFile, "utf-8");
    expect(content).toContain("export MY_KEY=");
    expect(content).toContain("my_value");
    expect(content).toContain("export OTHER=");
    expect(content).toContain("value2");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── inject_env_vars_local ────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload and run functions without server_ip", () => {
    const dir = createTempDir();
    const logFile = join(dir, "calls.log");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { echo "UPLOAD:$1:$2" >> "${logFile}"; }
      mock_run() { echo "RUN:$1" >> "${logFile}"; }
      inject_env_vars_local "mock_upload" "mock_run" \
        "API_KEY=local-test" "URL=https://local.test"
    `);
    expect(result.exitCode).toBe(0);

    const log = readFileSync(logFile, "utf-8");
    // inject_env_vars_local doesn't pass server_ip
    expect(log).toContain("UPLOAD:");
    expect(log).toContain("/tmp/env_config");
    expect(log).toContain("RUN:");
    expect(log).toContain(".zshrc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should generate env config with correct exports", () => {
    const dir = createTempDir();
    const captureFile = join(dir, "captured_env.sh");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { cp "$1" "${captureFile}"; }
      mock_run() { :; }
      inject_env_vars_local "mock_upload" "mock_run" \
        "OPENROUTER_API_KEY=sk-or-test" "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(captureFile, "utf-8");
    expect(content).toContain("export OPENROUTER_API_KEY=");
    expect(content).toContain("sk-or-test");
    expect(content).toContain("export ANTHROPIC_BASE_URL=");
    expect(content).toContain("https://openrouter.ai/api");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── track_temp_file and cleanup_temp_files ────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  it("should track a temp file and clean it up", () => {
    const dir = createTempDir();
    const tempFile = join(dir, "secret-credentials.tmp");
    writeFileSync(tempFile, "secret-api-key-contents");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      cleanup_temp_files
      if [[ -f "${tempFile}" ]]; then
        echo "FILE_EXISTS"
      else
        echo "FILE_REMOVED"
      fi
    `);
    expect(result.stdout).toContain("FILE_REMOVED");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should track multiple temp files and clean all of them", () => {
    const dir = createTempDir();
    const f1 = join(dir, "temp1.tmp");
    const f2 = join(dir, "temp2.tmp");
    const f3 = join(dir, "temp3.tmp");
    writeFileSync(f1, "data1");
    writeFileSync(f2, "data2");
    writeFileSync(f3, "data3");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${f1}"
      track_temp_file "${f2}"
      track_temp_file "${f3}"
      cleanup_temp_files
      echo "F1=$(test -f "${f1}" && echo EXISTS || echo GONE)"
      echo "F2=$(test -f "${f2}" && echo EXISTS || echo GONE)"
      echo "F3=$(test -f "${f3}" && echo EXISTS || echo GONE)"
    `);
    expect(result.stdout).toContain("F1=GONE");
    expect(result.stdout).toContain("F2=GONE");
    expect(result.stdout).toContain("F3=GONE");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should not error when cleaning up non-existent files", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "/tmp/nonexistent-file-$(date +%s%N)"
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should preserve exit code through cleanup", () => {
    // cleanup_temp_files captures and returns the original exit code
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      (exit 42)
      cleanup_temp_files
      echo "EXIT=$?"
    `);
    expect(result.stdout).toContain("EXIT=42");
  });
});

// ── register_cleanup_trap ────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should register trap handlers for EXIT INT TERM", () => {
    const result = runBash(`
      register_cleanup_trap
      trap -p EXIT
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });
});

// ── calculate_retry_backoff ──────────────────────────────────────────────

describe("calculate_retry_backoff", () => {
  it("should return a value within jitter range of the interval", () => {
    // Run 20 times to test jitter (±20% means 80%-120% of interval)
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const result = runBash(`calculate_retry_backoff 10 60`);
      const value = parseInt(result.stdout, 10);
      results.push(value);
    }

    // All values should be within 80%-120% of 10 (i.e., 8-12)
    for (const v of results) {
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(12);
    }
  });

  it("should produce varying values due to jitter", () => {
    // Run enough times to see at least some variation
    const results: number[] = [];
    for (let i = 0; i < 30; i++) {
      const result = runBash(`calculate_retry_backoff 100 1000`);
      results.push(parseInt(result.stdout, 10));
    }

    const unique = new Set(results);
    // With 30 samples and ±20% jitter on 100, we should see variation
    expect(unique.size).toBeGreaterThan(1);
  });

  it("should handle interval of 1", () => {
    const result = runBash(`calculate_retry_backoff 1 60`);
    const value = parseInt(result.stdout, 10);
    // 1 * 0.8 = 0.8 rounds to 0 or 1, 1 * 1.2 = 1.2 rounds to 1
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(2);
  });

  it("should fall back to plain interval when python3 fails", () => {
    // This test verifies the `|| echo "${interval}"` fallback
    const result = runBash(`
      # Override python3 to fail
      python3() { return 1; }
      export -f python3
      calculate_retry_backoff 5 60
    `);
    expect(result.stdout).toBe("5");
  });
});

// ── _update_retry_interval ───────────────────────────────────────────────

describe("_update_retry_interval", () => {
  it("should double the interval", () => {
    const result = runBash(`
      interval=5
      max_interval=60
      _update_retry_interval interval max_interval
      echo "$interval"
    `);
    expect(result.stdout).toBe("10");
  });

  it("should cap at max_interval", () => {
    const result = runBash(`
      interval=40
      max_interval=60
      _update_retry_interval interval max_interval
      echo "$interval"
    `);
    expect(result.stdout).toBe("60");
  });

  it("should stay at max when already at max", () => {
    const result = runBash(`
      interval=60
      max_interval=60
      _update_retry_interval interval max_interval
      echo "$interval"
    `);
    expect(result.stdout).toBe("60");
  });

  it("should handle doubling from 1", () => {
    const result = runBash(`
      interval=1
      max_interval=100
      _update_retry_interval interval max_interval
      echo "$interval"
    `);
    expect(result.stdout).toBe("2");
  });

  it("should handle sequence of doublings", () => {
    const result = runBash(`
      interval=2
      max_interval=30
      _update_retry_interval interval max_interval
      echo "$interval"
      _update_retry_interval interval max_interval
      echo "$interval"
      _update_retry_interval interval max_interval
      echo "$interval"
      _update_retry_interval interval max_interval
      echo "$interval"
    `);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("4");    // 2 -> 4
    expect(lines[1]).toBe("8");    // 4 -> 8
    expect(lines[2]).toBe("16");   // 8 -> 16
    expect(lines[3]).toBe("30");   // 16 -> 32 -> capped to 30
  });

  it("should modify the named variable in-place", () => {
    const result = runBash(`
      my_interval=3
      my_max=100
      _update_retry_interval my_interval my_max
      echo "$my_interval"
    `);
    expect(result.stdout).toBe("6");
  });
});

// ── Integration: _save_token_to_config + _load_token_from_config ─────────

describe("save and load token round-trip", () => {
  it("should save and reload a simple token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "roundtrip.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "round-trip-token"
      unset MY_TOKEN
      _load_token_from_config "${configFile}" "MY_TOKEN" "Test"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("round-trip-token");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should save and reload a token with special characters", () => {
    const dir = createTempDir();
    const configFile = join(dir, "special.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" 'sk-or-v1-abc/def+ghi=jkl'
      unset MY_TOKEN
      _load_token_from_config "${configFile}" "MY_TOKEN" "Test"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sk-or-v1-abc/def+ghi=jkl");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should overwrite existing config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "overwrite.json");

    runBash(`_save_token_to_config "${configFile}" "first-token"`);
    runBash(`_save_token_to_config "${configFile}" "second-token"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" "MY_TOKEN" "Test"
      echo "$MY_TOKEN"
    `);
    expect(result.stdout).toContain("second-token");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Integration: inject_env_vars generates valid shell ────────────────────

describe("inject_env_vars generates valid shell", () => {
  it("should generate shell that can be sourced", () => {
    const dir = createTempDir();
    const envFile = join(dir, "env.sh");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { cp "$1" "${envFile}"; }
      mock_run() { :; }
      inject_env_vars_local "mock_upload" "mock_run" \
        "TEST_VAR=hello" "OTHER_VAR=world"
      # Now source the generated file and check the vars
      source "${envFile}"
      echo "TEST=\$TEST_VAR OTHER=\$OTHER_VAR"
    `);
    expect(result.stdout).toContain("TEST=hello");
    expect(result.stdout).toContain("OTHER=world");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle values with spaces in generated shell", () => {
    const dir = createTempDir();
    const envFile = join(dir, "env.sh");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { cp "$1" "${envFile}"; }
      mock_run() { :; }
      inject_env_vars_local "mock_upload" "mock_run" \
        "MSG=hello world"
      source "${envFile}"
      echo "MSG=\$MSG"
    `);
    expect(result.stdout).toContain("MSG=hello world");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle values with special characters in generated shell", () => {
    const dir = createTempDir();
    const envFile = join(dir, "env.sh");

    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      mock_upload() { cp "$1" "${envFile}"; }
      mock_run() { :; }
      inject_env_vars_local "mock_upload" "mock_run" \
        "URL=https://openrouter.ai/api/v1"
      source "${envFile}"
      echo "URL=\$URL"
    `);
    expect(result.stdout).toContain("URL=https://openrouter.ai/api/v1");

    rmSync(dir, { recursive: true, force: true });
  });
});
