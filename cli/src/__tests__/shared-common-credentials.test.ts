import { describe, it, expect, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management functions in shared/common.sh:
 *
 * - _load_token_from_env: Load API token from environment variable
 * - _load_token_from_config: Load API token from JSON config file
 * - _validate_token_with_provider: Validate token via provider test function
 * - _save_token_to_config: Save API token to JSON config file with json_escape
 * - inject_env_vars_ssh: Inject env vars into remote server via SSH callbacks
 * - inject_env_vars_local: Inject env vars for local/non-SSH providers
 * - _multi_creds_all_env_set: Check if all env vars in a list are non-empty
 * - _multi_creds_load_config: Load multiple credentials from JSON config
 * - _multi_creds_validate: Validate multi-credentials via test function
 *
 * These functions are used by every cloud provider script but previously
 * had zero test coverage. They handle sensitive API tokens and are
 * security-critical.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/** Temp dirs to clean up after each test */
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Uses spawnSync to capture both stdout and stderr regardless of exit code.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(script: string, env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const envVars = env ? { ...process.env, ...env } : process.env;
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: envVars,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// ── _load_token_from_env ────────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(
      `_load_token_from_env "MY_TEST_TOKEN" "TestProvider"`,
      { MY_TEST_TOKEN: "sk-test-123" }
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(
      `_load_token_from_env "NONEXISTENT_TOKEN_VAR_XYZ" "TestProvider"`,
      { NONEXISTENT_TOKEN_VAR_XYZ: "" }
    );
    expect(result.exitCode).toBe(1);
  });

  it("should log provider name when env var is found", () => {
    const result = runBash(
      `_load_token_from_env "MY_TOKEN" "Lambda"`,
      { MY_TOKEN: "test-value" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Lambda");
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(
      `MY_EMPTY_VAR="" && _load_token_from_env "MY_EMPTY_VAR" "TestProvider"`
    );
    expect(result.exitCode).toBe(1);
  });
});

// ── _load_token_from_config ─────────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from api_key field in config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-saved-token" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider" && echo "$MY_TOKEN"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-saved-token");
  });

  it("should load token from token field in config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "tok-12345" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "CLOUD_TOKEN" "CloudProvider" && echo "$CLOUD_TOKEN"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tok-12345");
  });

  it("should prefer api_key over token when both present", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "api-key-val", token: "token-val" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "MY_TOKEN" "Provider" && echo "$MY_TOKEN"`
    );
    expect(result.exitCode).toBe(0);
    // The python expression uses `or` so api_key takes priority
    expect(result.stdout).toBe("api-key-val");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(
      `_load_token_from_config "/nonexistent/path/config.json" "MY_TOKEN" "Provider"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has no api_key or token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin", other_field: "value" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "MY_TOKEN" "Provider"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file contains invalid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "not valid json {{{");

    const result = runBash(
      `_load_token_from_config "${configFile}" "MY_TOKEN" "Provider"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when api_key is empty string", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "MY_TOKEN" "Provider"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should export the token as the specified env var", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "my-secret-key" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "CUSTOM_VAR_NAME" "Provider" && echo "$CUSTOM_VAR_NAME"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-secret-key");
  });

  it("should log config file path on success", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "key123" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" "MY_TOKEN" "Provider"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(configFile);
  });
});

// ── _validate_token_with_provider ───────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_success() { return 0; }
      _validate_token_with_provider "test_success" "MY_TOKEN" "Provider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="test-token"
      _validate_token_with_provider "test_fail" "MY_TOKEN" "Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 when test function is empty (no validation)", () => {
    const result = runBash(
      `_validate_token_with_provider "" "MY_TOKEN" "Provider"`
    );
    expect(result.exitCode).toBe(0);
  });

  it("should unset the env var when validation fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="test-token"
      _validate_token_with_provider "test_fail" "MY_TOKEN" "Provider"
      echo "TOKEN_AFTER=\${MY_TOKEN:-EMPTY}"
    `);
    // The function returns 1 and the script exits due to set -e in common.sh
    // So we need to check differently
    const result2 = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="test-token"
      _validate_token_with_provider "test_fail" "MY_TOKEN" "Provider" || true
      echo "TOKEN_AFTER=\${MY_TOKEN:-EMPTY}"
    `);
    expect(result2.stdout).toContain("TOKEN_AFTER=EMPTY");
  });

  it("should show error message with provider name on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="test-token"
      _validate_token_with_provider "test_fail" "MY_TOKEN" "Hetzner" || true
    `);
    expect(result.stderr).toContain("Hetzner");
    expect(result.stderr).toContain("failed");
  });

  it("should include env var name in fix instructions", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export HCLOUD_TOKEN="test-token"
      _validate_token_with_provider "test_fail" "HCLOUD_TOKEN" "Hetzner" || true
    `);
    expect(result.stderr).toContain("HCLOUD_TOKEN");
  });
});

// ── _save_token_to_config ───────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("should save token to a new config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "sub", "config.json");

    const result = runBash(`_save_token_to_config "${configFile}" "my-api-key-123"`);
    expect(result.exitCode).toBe(0);

    const saved = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(saved.api_key).toBe("my-api-key-123");
    expect(saved.token).toBe("my-api-key-123");
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const configFile = join(dir, "nested", "deep", "config.json");

    const result = runBash(`_save_token_to_config "${configFile}" "test-key"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);
  });

  it("should set restrictive file permissions (600)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "secret-key"`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });

  it("should produce valid JSON output", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "test-key"`);

    const content = readFileSync(configFile, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("should escape special characters in token via json_escape", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    // Token with quotes, backslashes, and special chars
    const result = runBash(`_save_token_to_config "${configFile}" 'key-with-"quotes"-and-\\backslash'`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('key-with-"quotes"-and-\\backslash');
  });

  it("should overwrite existing config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "old-key" }));

    runBash(`_save_token_to_config "${configFile}" "new-key"`);

    const saved = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(saved.api_key).toBe("new-key");
  });

  it("should store both api_key and token with same value", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "dual-key-value"`);

    const saved = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(saved.api_key).toBe("dual-key-value");
    expect(saved.token).toBe("dual-key-value");
  });

  it("should log success message with config file path", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    const result = runBash(`_save_token_to_config "${configFile}" "key"`);
    expect(result.stderr).toContain(configFile);
    expect(result.stderr).toContain("saved");
  });
});

// ── inject_env_vars_ssh ─────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should call upload function with server IP and temp file", () => {
    const dir = createTempDir();
    const logFile = join(dir, "calls.log");

    const result = runBash(`
      mock_upload() { echo "UPLOAD:$1:$2:$3" >> "${logFile}"; }
      mock_run() { echo "RUN:$1:$2" >> "${logFile}"; }
      inject_env_vars_ssh "192.168.1.1" "mock_upload" "mock_run" "KEY1=val1"
    `);
    expect(result.exitCode).toBe(0);

    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("UPLOAD:192.168.1.1:");
    expect(log).toContain("/tmp/env_config");
    expect(log).toContain("RUN:192.168.1.1:");
  });

  it("should generate env config with correct export statements", () => {
    const dir = createTempDir();
    const captureFile = join(dir, "env_content.txt");

    const result = runBash(`
      mock_upload() {
        cp "$2" "${captureFile}"
      }
      mock_run() { true; }
      inject_env_vars_ssh "10.0.0.1" "mock_upload" "mock_run" "API_KEY=sk-test" "BASE_URL=https://api.example.com"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(captureFile, "utf-8");
    expect(content).toContain("export API_KEY='sk-test'");
    expect(content).toContain("export BASE_URL='https://api.example.com'");
  });

  it("should pass multiple env vars correctly", () => {
    const dir = createTempDir();
    const captureFile = join(dir, "env_content.txt");

    const result = runBash(`
      mock_upload() { cp "$2" "${captureFile}"; }
      mock_run() { true; }
      inject_env_vars_ssh "10.0.0.1" "mock_upload" "mock_run" "VAR1=one" "VAR2=two" "VAR3=three"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(captureFile, "utf-8");
    expect(content).toContain("export VAR1='one'");
    expect(content).toContain("export VAR2='two'");
    expect(content).toContain("export VAR3='three'");
  });

  it("should run append command on remote server", () => {
    const dir = createTempDir();
    const logFile = join(dir, "run.log");

    const result = runBash(`
      mock_upload() { true; }
      mock_run() { echo "CMD:$2" >> "${logFile}"; }
      inject_env_vars_ssh "10.0.0.1" "mock_upload" "mock_run" "KEY=val"
    `);
    expect(result.exitCode).toBe(0);

    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("cat /tmp/env_config >> ~/.zshrc");
    expect(log).toContain("rm /tmp/env_config");
  });
});

// ── inject_env_vars_local ───────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload function without server IP", () => {
    const dir = createTempDir();
    const logFile = join(dir, "calls.log");

    const result = runBash(`
      mock_upload() { echo "UPLOAD:$1:$2" >> "${logFile}"; }
      mock_run() { echo "RUN:$1" >> "${logFile}"; }
      inject_env_vars_local "mock_upload" "mock_run" "KEY1=val1"
    `);
    expect(result.exitCode).toBe(0);

    const log = readFileSync(logFile, "utf-8");
    // inject_env_vars_local passes (temp_file, remote_path) -- no server IP
    expect(log).toContain("UPLOAD:");
    expect(log).toContain("/tmp/env_config");
  });

  it("should generate env config with export statements", () => {
    const dir = createTempDir();
    const captureFile = join(dir, "env_content.txt");

    const result = runBash(`
      mock_upload() { cp "$1" "${captureFile}"; }
      mock_run() { true; }
      inject_env_vars_local "mock_upload" "mock_run" "OPENROUTER_API_KEY=sk-or-v1-test" "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(captureFile, "utf-8");
    expect(content).toContain("export OPENROUTER_API_KEY='sk-or-v1-test'");
    expect(content).toContain("export ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
  });

  it("should include spawn:env marker in generated config", () => {
    const dir = createTempDir();
    const captureFile = join(dir, "env_content.txt");

    const result = runBash(`
      mock_upload() { cp "$1" "${captureFile}"; }
      mock_run() { true; }
      inject_env_vars_local "mock_upload" "mock_run" "KEY=val"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(captureFile, "utf-8");
    expect(content).toContain("[spawn:env]");
  });

  it("should run append command without server IP arg", () => {
    const dir = createTempDir();
    const logFile = join(dir, "run.log");

    const result = runBash(`
      mock_upload() { true; }
      mock_run() { echo "CMD:$1" >> "${logFile}"; }
      inject_env_vars_local "mock_upload" "mock_run" "KEY=val"
    `);
    expect(result.exitCode).toBe(0);

    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("cat /tmp/env_config >> ~/.zshrc");
    expect(log).toContain("rm /tmp/env_config");
  });
});

// ── _multi_creds_all_env_set ────────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(
      `export VAR_A="val_a" VAR_B="val_b" && _multi_creds_all_env_set "VAR_A" "VAR_B"`
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when one env var is missing", () => {
    const result = runBash(
      `export VAR_A="val_a" && _multi_creds_all_env_set "VAR_A" "MISSING_VAR_XYZ"`,
      { MISSING_VAR_XYZ: "" }
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(
      `export VAR_A="" && _multi_creds_all_env_set "VAR_A"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with single env var set", () => {
    const result = runBash(
      `export SINGLE_VAR="value" && _multi_creds_all_env_set "SINGLE_VAR"`
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when first var is empty but second is set", () => {
    const result = runBash(
      `export FIRST_VAR="" SECOND_VAR="set" && _multi_creds_all_env_set "FIRST_VAR" "SECOND_VAR"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when last var is empty", () => {
    const result = runBash(
      `export A="set" B="set" C="" && _multi_creds_all_env_set "A" "B" "C"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with three vars all set", () => {
    const result = runBash(
      `export X="1" Y="2" Z="3" && _multi_creds_all_env_set "X" "Y" "Z"`
    );
    expect(result.exitCode).toBe(0);
  });
});

// ── _multi_creds_load_config ────────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("should load multiple credentials from config file into env vars", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "s3cret",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 "CRED_USER" "CRED_PASS" "username" "password"
      echo "USER=$CRED_USER"
      echo "PASS=$CRED_PASS"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=admin");
    expect(result.stdout).toContain("PASS=s3cret");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(
      `_multi_creds_load_config "/nonexistent.json" 1 "MY_VAR" "my_key"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a required field is empty in config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 "CRED_USER" "CRED_PASS" "username" "password"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a required field is missing from config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 "CRED_USER" "CRED_PASS" "username" "password"`
    );
    expect(result.exitCode).toBe(1);
  });

  it("should export all env vars when all fields present", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "cid-123",
      client_secret: "secret-456",
      api_key: "key-789",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 3 "CID" "CSECRET" "AKEY" "client_id" "client_secret" "api_key"
      echo "$CID|$CSECRET|$AKEY"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cid-123|secret-456|key-789");
  });
});

// ── _multi_creds_validate ───────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export A="val" B="val"
      _multi_creds_validate "test_ok" "Provider" "A" "B"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function is empty (no validation)", () => {
    const result = runBash(
      `_multi_creds_validate "" "Provider" "A" "B"`
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 and unset env vars when validation fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_CRED_A="val_a" MY_CRED_B="val_b"
      _multi_creds_validate "test_fail" "Provider" "MY_CRED_A" "MY_CRED_B" || true
      echo "A=\${MY_CRED_A:-EMPTY}"
      echo "B=\${MY_CRED_B:-EMPTY}"
    `);
    expect(result.stdout).toContain("A=EMPTY");
    expect(result.stdout).toContain("B=EMPTY");
  });

  it("should show provider name in error message on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      _multi_creds_validate "test_fail" "UpCloud" "V1" "V2" || true
    `);
    expect(result.stderr).toContain("UpCloud");
  });

  it("should log testing message with provider name", () => {
    const result = runBash(`
      test_ok() { return 0; }
      _multi_creds_validate "test_ok" "Contabo"
    `);
    expect(result.stderr).toContain("Contabo");
    expect(result.stderr).toContain("Testing");
  });
});

// ── Integration: _save_token_to_config -> _load_token_from_config ───────────

describe("credential round-trip", () => {
  it("should save and reload a token correctly", () => {
    const dir = createTempDir();
    const configFile = join(dir, "roundtrip.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "sk-or-v1-round-trip-test"
      _load_token_from_config "${configFile}" "ROUND_TRIP_TOKEN" "TestProvider"
      echo "$ROUND_TRIP_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-or-v1-round-trip-test");
  });

  it("should handle token with special characters through round-trip", () => {
    const dir = createTempDir();
    const configFile = join(dir, "special.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" 'tok-with-"quotes"'
      _load_token_from_config "${configFile}" "SPECIAL_TOKEN" "Provider"
      echo "$SPECIAL_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('tok-with-"quotes"');
  });

  it("should overwrite and reload correctly", () => {
    const dir = createTempDir();
    const configFile = join(dir, "overwrite.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "old-key"
      _save_token_to_config "${configFile}" "new-key"
      _load_token_from_config "${configFile}" "MY_TOKEN" "Provider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("new-key");
  });
});
