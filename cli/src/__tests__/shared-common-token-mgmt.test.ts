import { describe, it, expect } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for token and credential management functions in shared/common.sh:
 *
 * - _load_token_from_env: load API token from environment variable
 * - _load_token_from_config: load API token from JSON config file
 * - _save_token_to_config: save API token to JSON config file with json_escape
 * - _validate_token_with_provider: validate token using a provider test function
 * - ensure_api_token_with_provider: full flow (env -> config -> prompt -> validate -> save)
 * - _multi_creds_all_env_set: check if all env vars in a list are set
 *
 * These functions are used by EVERY cloud provider script and are security-critical
 * because they handle API tokens that grant access to cloud infrastructure. A bug
 * in token storage (e.g., missing json_escape) could corrupt config files or expose
 * tokens to injection attacks.
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

function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _load_token_from_env ────────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export TEST_TOKEN_ABC="my-token-value"
      _load_token_from_env TEST_TOKEN_ABC "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using TestProvider API token from environment");
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset TEST_TOKEN_MISSING 2>/dev/null
      _load_token_from_env TEST_TOKEN_MISSING "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export TEST_TOKEN_EMPTY=""
      _load_token_from_env TEST_TOKEN_EMPTY "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should use provider name in log message", () => {
    const result = runBash(`
      export MY_TOKEN="abc123"
      _load_token_from_env MY_TOKEN "Hetzner Cloud"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Hetzner Cloud");
  });
});

// ── _load_token_from_config ──────────────────────────────────────────────────

describe("_load_token_from_config", () => {
  let tempDir: string;

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/nonexistent/path/config.json" TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should load token from 'api_key' field", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "test-api-key-123" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
      echo "$TEST_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test-api-key-123");
    expect(result.stderr).toContain("Using TestProvider API token from");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should load token from 'token' field when api_key is empty", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "my-token-456" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
      echo "$TEST_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-token-456");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should prefer api_key over token when both are present", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "primary-key", token: "fallback-token" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
      echo "$TEST_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("primary-key");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return 1 when config file has neither api_key nor token", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return 1 when config file has empty api_key and no token", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return 1 when config file contains invalid JSON", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, "not valid json{{{");

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should export the env var with the loaded token value", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "exported-token" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" HCLOUD_TOKEN "Hetzner"
      echo "$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("exported-token");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should handle token with special characters", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "token-with-special/chars=abc+def" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" TEST_TOKEN "TestProvider"
      echo "$TEST_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("token-with-special/chars=abc+def");

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── _save_token_to_config ────────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  let tempDir: string;

  it("should create config file with token in JSON format", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "provider.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "my-secret-token"
    `);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("my-secret-token");
    expect(parsed.token).toBe("my-secret-token");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should create parent directories if they don't exist", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "nested", "deep", "config.json");

    const result = runBash(`
      _save_token_to_config "${configFile}" "nested-token"
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("nested-token");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should set file permissions to 600 (owner read/write only)", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "secure.json");

    runBash(`_save_token_to_config "${configFile}" "secure-token"`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should properly escape token with double quotes via json_escape", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "escape.json");

    runBash(`_save_token_to_config "${configFile}" 'token-with-"quotes"'`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('token-with-"quotes"');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should properly escape token with backslashes via json_escape", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "backslash.json");

    runBash(`_save_token_to_config "${configFile}" 'token\\\\with\\\\backslashes'`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toContain("token");
    expect(parsed.api_key).toContain("backslashes");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should produce valid JSON that can be loaded back", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "roundtrip.json");

    runBash(`_save_token_to_config "${configFile}" "roundtrip-token-xyz"`);

    // Load it back using _load_token_from_config
    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED_TOKEN "TestProvider"
      echo "$LOADED_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("roundtrip-token-xyz");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should overwrite existing config file", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "overwrite.json");

    runBash(`_save_token_to_config "${configFile}" "old-token"`);
    runBash(`_save_token_to_config "${configFile}" "new-token"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("new-token");
    expect(parsed.token).toBe("new-token");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should log success message with config file path", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "log-test.json");

    const result = runBash(`_save_token_to_config "${configFile}" "test-token"`);
    expect(result.stderr).toContain("saved to");
    expect(result.stderr).toContain(configFile);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── _validate_token_with_provider ────────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when test_func is empty (no validation needed)", () => {
    const result = runBash(`
      _validate_token_with_provider "" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_func_ok() { return 0; }
      export MY_TOKEN="valid-token"
      _validate_token_with_provider test_func_ok MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_TOKEN="invalid-token"
      _validate_token_with_provider test_func_fail MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset the env var when validation fails", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_TOKEN="should-be-unset"
      _validate_token_with_provider test_func_fail MY_TOKEN "TestProvider"
      echo "TOKEN_VALUE=\${MY_TOKEN:-UNSET}"
    `);
    // The function returns 1, but we echo after to check unset
    expect(result.stdout).toContain("TOKEN_VALUE=UNSET");
  });

  it("should show error messages when validation fails", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_TOKEN="bad"
      _validate_token_with_provider test_func_fail MY_TOKEN "Lambda"
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Authentication failed");
    expect(result.stderr).toContain("Lambda");
    expect(result.stderr).toContain("How to fix");
  });

  it("should include env var name in error message", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export LAMBDA_API_KEY="bad"
      _validate_token_with_provider test_func_fail LAMBDA_API_KEY "Lambda"
    `);
    expect(result.stderr).toContain("LAMBDA_API_KEY");
  });
});

// ── _multi_creds_all_env_set ────────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(`
      export VAR_A="a"
      export VAR_B="b"
      export VAR_C="c"
      _multi_creds_all_env_set VAR_A VAR_B VAR_C
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when one env var is missing", () => {
    const result = runBash(`
      export VAR_A="a"
      unset VAR_B 2>/dev/null
      export VAR_C="c"
      _multi_creds_all_env_set VAR_A VAR_B VAR_C
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when one env var is empty string", () => {
    const result = runBash(`
      export VAR_A="a"
      export VAR_B=""
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with single env var that is set", () => {
    const result = runBash(`
      export SINGLE_VAR="value"
      _multi_creds_all_env_set SINGLE_VAR
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when all env vars are missing", () => {
    const result = runBash(`
      unset X_VAR Y_VAR Z_VAR 2>/dev/null
      _multi_creds_all_env_set X_VAR Y_VAR Z_VAR
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with no arguments (vacuously true)", () => {
    const result = runBash(`
      _multi_creds_all_env_set
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _multi_creds_validate ───────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when test_func is empty (no validation)", () => {
    const result = runBash(`
      _multi_creds_validate "" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      ok_func() { return 0; }
      _multi_creds_validate ok_func "TestProvider" VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 and unset env vars when test function fails", () => {
    const result = runBash(`
      fail_func() { return 1; }
      export CRED_A="secret-a"
      export CRED_B="secret-b"
      _multi_creds_validate fail_func "TestProvider" CRED_A CRED_B
      echo "A=\${CRED_A:-UNSET} B=\${CRED_B:-UNSET}"
    `);
    expect(result.stdout).toContain("A=UNSET");
    expect(result.stdout).toContain("B=UNSET");
  });

  it("should show provider name in error message on failure", () => {
    const result = runBash(`
      fail_func() { return 1; }
      _multi_creds_validate fail_func "Contabo" VAR_X
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid Contabo credentials");
  });

  it("should show helpful error messages on failure", () => {
    const result = runBash(`
      fail_func() { return 1; }
      _multi_creds_validate fail_func "MyCloud" VAR_X
    `);
    expect(result.stderr).toContain("expired");
    expect(result.stderr).toContain("re-run");
  });

  it("should log testing message before validation", () => {
    const result = runBash(`
      ok_func() { return 0; }
      _multi_creds_validate ok_func "Lambda" VAR_X
    `);
    expect(result.stderr).toContain("Testing Lambda credentials");
  });
});

// ── ensure_api_token_with_provider (env path) ───────────────────────────────

describe("ensure_api_token_with_provider (env var path)", () => {
  it("should return 0 immediately when env var is already set", () => {
    const result = runBash(`
      export HCLOUD_TOKEN="existing-token"
      ensure_api_token_with_provider "Hetzner" HCLOUD_TOKEN "/tmp/unused.json" "https://hetzner.com"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using Hetzner API token from environment");
  });

  it("should preserve the existing env var value", () => {
    const result = runBash(`
      export HCLOUD_TOKEN="my-existing-token"
      ensure_api_token_with_provider "Hetzner" HCLOUD_TOKEN "/tmp/unused.json" "https://hetzner.com"
      echo "$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-existing-token");
  });

  it("should not read config file when env var is set", () => {
    const result = runBash(`
      export LAMBDA_API_KEY="from-env"
      ensure_api_token_with_provider "Lambda" LAMBDA_API_KEY "/nonexistent/config.json" "https://lambda.ai"
    `);
    expect(result.exitCode).toBe(0);
    // Should succeed even though config file path is invalid
  });
});

// ── ensure_api_token_with_provider (config path) ────────────────────────────

describe("ensure_api_token_with_provider (config file path)", () => {
  let tempDir: string;

  it("should load token from config file when env var is not set", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "config-token-abc" }));

    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      ensure_api_token_with_provider "TestProvider" MY_TOKEN "${configFile}" "https://example.com"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("config-token-abc");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should log config file path when loading from config", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "config-token" }));

    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      ensure_api_token_with_provider "TestProvider" MY_TOKEN "${configFile}" "https://example.com"
    `);
    expect(result.stderr).toContain("Using TestProvider API token from");

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── _save_json_config ──────────────────────────────────────────────────────

describe("_save_json_config", () => {
  let tempDir: string;

  it("should save single key-value pair as JSON", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "single.json");

    runBash(`_save_json_config "${configFile}" "api_key" "my-secret"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("my-secret");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should save multiple key-value pairs as JSON", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "multi.json");

    runBash(`_save_json_config "${configFile}" "client_id" "id-123" "client_secret" "secret-456"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.client_id).toBe("id-123");
    expect(parsed.client_secret).toBe("secret-456");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should set file permissions to 600", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "perms.json");

    runBash(`_save_json_config "${configFile}" "key" "val"`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should create parent directories", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "deep", "nested", "config.json");

    runBash(`_save_json_config "${configFile}" "token" "value"`);

    expect(existsSync(configFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.token).toBe("value");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should produce valid JSON with special characters in values", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "special.json");

    runBash(`_save_json_config "${configFile}" "key" 'value-with-"quotes"'`);

    // Should be valid JSON
    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.key).toBe('value-with-"quotes"');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should round-trip with _load_json_config_fields", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "roundtrip.json");

    runBash(`_save_json_config "${configFile}" "username" "admin" "password" "s3cret"`);

    const result = runBash(`
      creds=$(_load_json_config_fields "${configFile}" username password)
      { read -r u; read -r p; } <<< "$creds"
      echo "u=$u p=$p"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("u=admin p=s3cret");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should log success message", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "log.json");

    const result = runBash(`_save_json_config "${configFile}" "key" "val"`);
    expect(result.stderr).toContain("Credentials saved to");
    expect(result.stderr).toContain(configFile);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── _load_json_config_fields ───────────────────────────────────────────────

describe("_load_json_config_fields", () => {
  let tempDir: string;

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_json_config_fields "/nonexistent/file.json" field1 field2
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should load single field from JSON", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "single.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "key-val" }));

    const result = runBash(`
      val=$(_load_json_config_fields "${configFile}" api_key)
      echo "$val"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("key-val");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should load multiple fields from JSON", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "multi.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "secret",
      region: "us-east"
    }));

    const result = runBash(`
      creds=$(_load_json_config_fields "${configFile}" username password region)
      { read -r u; read -r p; read -r r; } <<< "$creds"
      echo "u=$u p=$p r=$r"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("u=admin p=secret r=us-east");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return empty string for missing fields", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "partial.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin" }));

    const result = runBash(`
      creds=$(_load_json_config_fields "${configFile}" username missing_field)
      { read -r u; read -r m; } <<< "$creds"
      echo "u=$u m=|$m|"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("u=admin");
    expect(result.stdout).toContain("m=||");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return 1 for invalid JSON", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "invalid.json");
    writeFileSync(configFile, "not json content");

    const result = runBash(`
      _load_json_config_fields "${configFile}" field1
    `);
    expect(result.exitCode).toBe(1);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ── save + load roundtrip (integration) ────────────────────────────────────

describe("token save + load roundtrip", () => {
  let tempDir: string;

  it("should save via _save_token_to_config and load via _load_token_from_config", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "roundtrip.json");

    runBash(`_save_token_to_config "${configFile}" "roundtrip-token-123"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED_TOKEN "TestProvider"
      echo "$LOADED_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("roundtrip-token-123");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should handle token with special characters through save/load cycle", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "special.json");

    // Token with characters that need JSON escaping
    runBash(`_save_token_to_config "${configFile}" "sk-or-v1-abc/def+ghi=jkl"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED_TOKEN "TestProvider"
      echo "$LOADED_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-or-v1-abc/def+ghi=jkl");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should save via _save_json_config and load via _load_json_config_fields", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "multi-roundtrip.json");

    runBash(`_save_json_config "${configFile}" "client_id" "id-abc" "client_secret" "secret-xyz"`);

    const result = runBash(`
      creds=$(_load_json_config_fields "${configFile}" client_id client_secret)
      { read -r id; read -r secret; } <<< "$creds"
      echo "id=$id secret=$secret"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("id=id-abc secret=secret-xyz");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should handle overwrite correctly in roundtrip", () => {
    tempDir = createTempDir();
    const configFile = join(tempDir, "overwrite.json");

    runBash(`_save_token_to_config "${configFile}" "old-token"`);
    runBash(`_save_token_to_config "${configFile}" "new-token"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED_TOKEN "TestProvider"
      echo "$LOADED_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("new-token");

    rmSync(tempDir, { recursive: true, force: true });
  });
});
