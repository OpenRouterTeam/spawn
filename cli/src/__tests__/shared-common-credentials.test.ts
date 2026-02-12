import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management functions in shared/common.sh:
 *
 * Single-token helpers (used by most cloud providers):
 *   - _load_token_from_env: check if env var is set
 *   - _load_token_from_config: load token from JSON config file
 *   - _validate_token_with_provider: validate token via provider API call
 *   - _save_token_to_config: save token to JSON config with json_escape
 *   - ensure_api_token_with_provider: orchestrator (env -> config -> prompt -> validate -> save)
 *
 * Multi-credential helpers (used by UpCloud, Contabo, OVH, etc.):
 *   - _multi_creds_all_env_set: check if all env vars in a list are set
 *   - _multi_creds_load_config: load multiple fields from JSON config into env vars
 *   - _multi_creds_validate: validate multi-credentials via test function
 *   - ensure_multi_credentials: orchestrator for multi-credential providers
 *
 * These functions had zero test coverage despite being used by every cloud
 * provider script. They are security-relevant because they handle API tokens,
 * passwords, and other credentials.
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
 * Create a temporary directory for test files.
 */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _load_token_from_env ────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export MY_TEST_TOKEN="sk-abc123"
      _load_token_from_env MY_TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset MY_TEST_TOKEN
      _load_token_from_env MY_TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export MY_TEST_TOKEN=""
      _load_token_from_env MY_TEST_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should log a message when token is found", () => {
    const result = runBash(`
      export MY_TEST_TOKEN="sk-abc123"
      _load_token_from_env MY_TEST_TOKEN "Lambda" 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Lambda");
    expect(result.stdout).toContain("API token from environment");
  });

  it("should work with various env var name formats", () => {
    const vars = ["HCLOUD_TOKEN", "DO_API_KEY", "LAMBDA_API_KEY", "VULTR_API_KEY"];
    for (const v of vars) {
      const result = runBash(`
        export ${v}="test-value"
        _load_token_from_env ${v} "Provider"
      `);
      expect(result.exitCode).toBe(0);
    }
  });
});

// ── _load_token_from_config ─────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from config file with api_key field", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-saved-token" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sk-saved-token");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should load token from config file with token field", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "hcloud-token-abc" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Hetzner"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hcloud-token-abc");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should prefer api_key over token when both present", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "preferred", token: "fallback" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Test"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("preferred");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/tmp/nonexistent-config-${Date.now()}.json" MY_TOKEN "Test"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has no api_key or token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin", other: "data" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Test"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 for invalid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "bad.json");
    writeFileSync(configFile, "{ not valid json !!!");

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Test"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when api_key is empty string", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Test"
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should export the env var with correct value", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-or-v1-abc123" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" HCLOUD_TOKEN "Hetzner"
      echo "value=\${HCLOUD_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("value=sk-or-v1-abc123");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should log provider name when token is loaded", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "test-key" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "DigitalOcean" 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DigitalOcean");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _validate_token_with_provider ───────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when no test function is provided (empty string)", () => {
    const result = runBash(`
      _validate_token_with_provider "" MY_TOKEN "Test"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      mock_test_success() { return 0; }
      export MY_TOKEN="valid-token"
      _validate_token_with_provider mock_test_success MY_TOKEN "Test"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      mock_test_failure() { return 1; }
      export MY_TOKEN="invalid-token"
      _validate_token_with_provider mock_test_failure MY_TOKEN "Lambda" 2>&1
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset env var when validation fails", () => {
    const result = runBash(`
      mock_test_failure() { return 1; }
      export MY_TOKEN="should-be-unset"
      _validate_token_with_provider mock_test_failure MY_TOKEN "Test" 2>/dev/null
      echo "after=\${MY_TOKEN:-EMPTY}"
    `);
    // The function should have unset MY_TOKEN
    expect(result.stdout).toContain("after=EMPTY");
  });

  it("should log error message on failure", () => {
    const result = runBash(`
      mock_test_failure() { return 1; }
      export MY_TOKEN="bad-token"
      _validate_token_with_provider mock_test_failure MY_TOKEN "Vultr" 2>&1
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Authentication failed");
    expect(result.stdout).toContain("Vultr");
  });

  it("should show helpful fix instructions on failure", () => {
    const result = runBash(`
      mock_test_failure() { return 1; }
      export MY_TOKEN="bad-token"
      _validate_token_with_provider mock_test_failure MY_TOKEN "Hetzner" 2>&1
    `);
    expect(result.stdout).toContain("How to fix");
    expect(result.stdout).toContain("MY_TOKEN");
  });
});

// ── _save_token_to_config ───────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("should save token to config file as valid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "save.json");

    const result = runBash(`_save_token_to_config "${configFile}" "sk-test-token-123"`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("sk-test-token-123");
    expect(parsed.token).toBe("sk-test-token-123");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const configFile = join(dir, "nested", "deep", "config.json");

    const result = runBash(`_save_token_to_config "${configFile}" "my-token"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should set restrictive file permissions (600)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "perms.json");

    runBash(`_save_token_to_config "${configFile}" "secret-token"`);

    const result = runBash(`stat -c %a "${configFile}" 2>/dev/null || stat -f %Lp "${configFile}"`);
    expect(result.stdout).toBe("600");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should properly escape special characters in token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "escape.json");

    runBash(`_save_token_to_config "${configFile}" 'token"with"quotes'`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('token"with"quotes');

    rmSync(dir, { recursive: true, force: true });
  });

  it("should store both api_key and token fields for compatibility", () => {
    const dir = createTempDir();
    const configFile = join(dir, "dual.json");

    runBash(`_save_token_to_config "${configFile}" "the-token"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    // Both fields should be present for backwards compat
    expect(parsed.api_key).toBe("the-token");
    expect(parsed.token).toBe("the-token");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should overwrite existing config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "overwrite.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "old-token", token: "old-token" }));

    runBash(`_save_token_to_config "${configFile}" "new-token"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("new-token");
    expect(parsed.token).toBe("new-token");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should roundtrip with _load_token_from_config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "roundtrip.json");

    runBash(`_save_token_to_config "${configFile}" "sk-or-v1-roundtrip-test"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED_TOKEN "Test"
      echo "\${LOADED_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sk-or-v1-roundtrip-test");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _multi_creds_all_env_set ────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(`
      export CRED_A="value-a"
      export CRED_B="value-b"
      _multi_creds_all_env_set CRED_A CRED_B
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when first env var is missing", () => {
    const result = runBash(`
      unset CRED_A 2>/dev/null
      export CRED_B="value-b"
      _multi_creds_all_env_set CRED_A CRED_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when second env var is missing", () => {
    const result = runBash(`
      export CRED_A="value-a"
      unset CRED_B 2>/dev/null
      _multi_creds_all_env_set CRED_A CRED_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export CRED_A=""
      _multi_creds_all_env_set CRED_A
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 for single set env var", () => {
    const result = runBash(`
      export SOLO_VAR="set"
      _multi_creds_all_env_set SOLO_VAR
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when any of three vars is missing", () => {
    const result = runBash(`
      export A="a"
      export B="b"
      unset C 2>/dev/null
      _multi_creds_all_env_set A B C
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 when all three vars are set", () => {
    const result = runBash(`
      export A="a"
      export B="b"
      export C="c"
      _multi_creds_all_env_set A B C
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _multi_creds_load_config ────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("should load two credentials from config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "multi.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "s3cret",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
      echo "user=\${MY_USER}"
      echo "pass=\${MY_PASS}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user=admin");
    expect(result.stdout).toContain("pass=s3cret");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should load three credentials from config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "triple.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "id-123",
      client_secret: "secret-456",
      zone: "eu-west-1",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 3 CID CSEC ZONE client_id client_secret zone
      echo "\${CID}|\${CSEC}|\${ZONE}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id-123|secret-456|eu-west-1");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _multi_creds_load_config "/tmp/nonexistent-${Date.now()}.json" 1 MY_VAR field
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a required field is missing", () => {
    const dir = createTempDir();
    const configFile = join(dir, "partial.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin" }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when a required field is empty string", () => {
    const dir = createTempDir();
    const configFile = join(dir, "empty.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin", password: "" }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
    `);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should export env vars correctly", () => {
    const dir = createTempDir();
    const configFile = join(dir, "export.json");
    writeFileSync(configFile, JSON.stringify({
      token: "my-api-token",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 1 API_TOKEN token
      echo "exported=\${API_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exported=my-api-token");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle special characters in config values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "special.json");
    writeFileSync(configFile, JSON.stringify({
      user: "admin@company.com",
      pass: "p@ss!w0rd#123",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 U P user pass
      echo "\${U}|\${P}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("admin@company.com|p@ss!w0rd#123");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _multi_creds_validate ───────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when no test function is provided", () => {
    const result = runBash(`
      _multi_creds_validate "" "TestProvider" VAR1 VAR2
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      mock_success() { return 0; }
      export VAR1="a" VAR2="b"
      _multi_creds_validate mock_success "TestProvider" VAR1 VAR2
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      mock_failure() { return 1; }
      export VAR1="a" VAR2="b"
      _multi_creds_validate mock_failure "OVH" VAR1 VAR2 2>/dev/null
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset all env vars when validation fails", () => {
    const result = runBash(`
      mock_failure() { return 1; }
      export V1="should-be-gone" V2="also-gone"
      _multi_creds_validate mock_failure "Test" V1 V2 2>/dev/null
      echo "v1=\${V1:-EMPTY} v2=\${V2:-EMPTY}"
    `);
    expect(result.stdout).toContain("v1=EMPTY");
    expect(result.stdout).toContain("v2=EMPTY");
  });

  it("should log error message with provider name on failure", () => {
    const result = runBash(`
      mock_failure() { return 1; }
      export V1="a"
      _multi_creds_validate mock_failure "Contabo" V1 2>&1
    `);
    expect(result.stdout).toContain("Invalid Contabo credentials");
  });

  it("should log testing message with provider name", () => {
    const result = runBash(`
      mock_success() { return 0; }
      _multi_creds_validate mock_success "UpCloud" VAR1 2>&1
    `);
    expect(result.stdout).toContain("Testing UpCloud credentials");
  });
});

// ── ensure_multi_credentials spec parsing ───────────────────────────────

describe("ensure_multi_credentials spec parsing", () => {
  it("should parse credential specs and use env vars when all set", () => {
    const result = runBash(`
      export MY_USER="admin"
      export MY_PASS="secret"
      # Since all env vars are set, it should return 0 without prompting
      ensure_multi_credentials "TestProvider" "/tmp/unused-${Date.now()}.json" "https://example.com" "" \
        "MY_USER:username:Username" "MY_PASS:password:Password"
      echo "user=\${MY_USER} pass=\${MY_PASS}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user=admin");
    expect(result.stdout).toContain("pass=secret");
  });

  it("should load from config when env vars are not set", () => {
    const dir = createTempDir();
    const configFile = join(dir, "creds.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "from-config-id",
      client_secret: "from-config-secret",
    }));

    const result = runBash(`
      unset CID CSEC 2>/dev/null
      ensure_multi_credentials "TestProvider" "${configFile}" "https://example.com" "" \
        "CID:client_id:Client ID" "CSEC:client_secret:Client Secret"
      echo "id=\${CID} secret=\${CSEC}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id=from-config-id");
    expect(result.stdout).toContain("secret=from-config-secret");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should load from config without re-validating (validation is only for prompted creds)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "creds.json");
    writeFileSync(configFile, JSON.stringify({
      user: "admin",
      pass: "anypass",
    }));

    // ensure_multi_credentials does NOT validate after loading from config (step 2).
    // Validation (step 4) only runs after interactive prompting (step 3).
    // This is by design: config was already validated when it was first saved.
    const result = runBash(`
      unset U P 2>/dev/null
      mock_validate_fail() { return 1; }
      ensure_multi_credentials "TestProvider" "${configFile}" "https://example.com" mock_validate_fail \
        "U:user:Username" "P:pass:Password"
      echo "exit_code=$?"
    `);
    // Should succeed because config loading bypasses validation
    expect(result.stdout).toContain("exit_code=0");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should validate credentials with test function when env vars are set", () => {
    const result = runBash(`
      export MY_TOKEN="valid"
      mock_validate_ok() { return 0; }
      ensure_multi_credentials "TestProvider" "/tmp/unused-${Date.now()}.json" "https://example.com" mock_validate_ok \
        "MY_TOKEN:token:API Token" 2>&1
      echo "result=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("result=valid");
  });
});

// ── _save_token_to_config + _load_token_from_config roundtrip ───────────

describe("token config roundtrip", () => {
  it("should roundtrip a standard API key", () => {
    const dir = createTempDir();
    const configFile = join(dir, "rt.json");

    runBash(`_save_token_to_config "${configFile}" "sk-or-v1-abc123def456"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED "Test"
      echo "\${LOADED}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sk-or-v1-abc123def456");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should roundtrip a token with special characters", () => {
    const dir = createTempDir();
    const configFile = join(dir, "rt-special.json");

    runBash(`_save_token_to_config "${configFile}" 'token/with+special=chars'`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED "Test"
      echo "\${LOADED}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("token/with+special=chars");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should roundtrip a long token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "rt-long.json");
    const longToken = "sk-" + "a".repeat(200);

    runBash(`_save_token_to_config "${configFile}" "${longToken}"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED "Test"
      echo "\${LOADED}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(longToken);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _multi_creds_load_config + _save_json_config roundtrip ──────────────

describe("multi-creds config roundtrip with _save_json_config", () => {
  it("should save and reload two credentials", () => {
    const dir = createTempDir();
    const configFile = join(dir, "multi-rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" username "admin" password "hunter2"
      _multi_creds_load_config "${configFile}" 2 U P username password
      echo "\${U}|\${P}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("admin|hunter2");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should save and reload three credentials (UpCloud pattern)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "upcloud-rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" username "admin" password "p@ss" zone "fi-hel1"
      _multi_creds_load_config "${configFile}" 3 U P Z username password zone
      echo "\${U}|\${P}|\${Z}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("admin|p@ss|fi-hel1");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should save and reload with special characters in values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "special-rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" key1 'val"with"quotes' key2 'val/with/slashes'
      _multi_creds_load_config "${configFile}" 2 V1 V2 key1 key2
      echo "\${V1}"
      echo "\${V2}"
    `);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain('val"with"quotes');
    expect(lines).toContain("val/with/slashes");

    rmSync(dir, { recursive: true, force: true });
  });
});
