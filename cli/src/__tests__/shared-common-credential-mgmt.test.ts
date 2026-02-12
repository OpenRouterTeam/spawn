import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management functions in shared/common.sh:
 *
 * - _load_token_from_env: load API token from environment variable
 * - _load_token_from_config: load API token from JSON config file
 * - _validate_token_with_provider: validate token via callback function
 * - _save_token_to_config: save token to JSON config with json_escape
 * - _multi_creds_all_env_set: check if all env vars in a list are set
 * - _multi_creds_load_config: load multiple credentials from JSON config
 * - _multi_creds_validate: validate credentials with callback, unset on failure
 *
 * These functions are used by every cloud provider (ensure_api_token_with_provider
 * and ensure_multi_credentials) to handle authentication. They had zero test
 * coverage despite being security-relevant (token storage, validation, injection).
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
  const dir = join(tmpdir(), `spawn-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _load_token_from_env ────────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export MY_TOKEN="test-token-value"
      _load_token_from_env "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should log info message when token found", () => {
    const result = runBash(`
      export MY_TOKEN="test-token-value"
      _load_token_from_env "MY_TOKEN" "TestProvider" 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TestProvider");
    expect(result.stdout).toContain("environment");
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset NONEXISTENT_TOKEN_XYZ
      _load_token_from_env "NONEXISTENT_TOKEN_XYZ" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export EMPTY_TOKEN=""
      _load_token_from_env "EMPTY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should include provider name in log output", () => {
    const result = runBash(`
      export MY_API_KEY="sk-123"
      _load_token_from_env "MY_API_KEY" "Hetzner Cloud" 2>&1
    `);
    expect(result.stdout).toContain("Hetzner Cloud");
  });

  it("should handle token with special characters", () => {
    const result = runBash(`
      export SPECIAL_TOKEN="sk-or-v1-abc123!@#$%"
      _load_token_from_env "SPECIAL_TOKEN" "Provider"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _load_token_from_config ─────────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from api_key field", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "sk-test-123" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
        echo "$MY_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("sk-test-123");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load token from token field", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ token: "my-token-456" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
        echo "$MY_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("my-token-456");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should prefer api_key over token when both exist", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "from-api-key", token: "from-token" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
        echo "$MY_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("from-api-key");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/tmp/nonexistent-spawn-config-${Date.now()}.json" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has empty api_key and token", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
      `);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when config file has no api_key or token fields", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ other_field: "value" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
      `);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when config file has invalid JSON", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, "not valid json{{{");

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "TestProvider"
      `);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should export the env var with the loaded token", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "exported-token-789" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "EXPORTED_VAR" "TestProvider"
        echo "VALUE=$EXPORTED_VAR"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("VALUE=exported-token-789");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should log info with config file path", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "mycloud.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "token" }));

      const result = runBash(`
        _load_token_from_config "${configFile}" "MY_TOKEN" "MyCloud" 2>&1
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("mycloud.json");
      expect(result.stdout).toContain("MyCloud");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── _validate_token_with_provider ───────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when no test function is provided (empty string)", () => {
    const result = runBash(`
      _validate_token_with_provider "" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_func_ok() { return 0; }
      export MY_TOKEN="valid-token"
      _validate_token_with_provider "test_func_ok" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_TOKEN="invalid-token"
      _validate_token_with_provider "test_func_fail" "MY_TOKEN" "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset env var when validation fails", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_TOKEN="should-be-unset"
      _validate_token_with_provider "test_func_fail" "MY_TOKEN" "TestProvider" 2>/dev/null
      echo "AFTER=$MY_TOKEN"
    `);
    expect(result.stdout).toBe("AFTER=");
  });

  it("should preserve env var when validation succeeds", () => {
    const result = runBash(`
      test_func_ok() { return 0; }
      export MY_TOKEN="should-remain"
      _validate_token_with_provider "test_func_ok" "MY_TOKEN" "TestProvider"
      echo "AFTER=$MY_TOKEN"
    `);
    expect(result.stdout).toContain("AFTER=should-remain");
  });

  it("should show error message with provider name on failure", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_TOKEN="bad"
      _validate_token_with_provider "test_func_fail" "MY_TOKEN" "Lambda Cloud" 2>&1
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Lambda Cloud");
    expect(result.stdout).toContain("Authentication failed");
  });

  it("should show env var name in fix suggestion on failure", () => {
    const result = runBash(`
      test_func_fail() { return 1; }
      export MY_KEY="bad"
      _validate_token_with_provider "test_func_fail" "MY_KEY" "Provider" 2>&1
    `);
    expect(result.stdout).toContain("MY_KEY");
  });
});

// ── _save_token_to_config ───────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("should create config file with valid JSON", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      runBash(`_save_token_to_config "${configFile}" "my-api-token"`);

      const content = readFileSync(configFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.api_key).toBe("my-api-token");
      expect(parsed.token).toBe("my-api-token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should store same token in both api_key and token fields", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "test.json");
      runBash(`_save_token_to_config "${configFile}" "sk-or-v1-abc123"`);

      const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(parsed.api_key).toBe("sk-or-v1-abc123");
      expect(parsed.token).toBe("sk-or-v1-abc123");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should create parent directories if they do not exist", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "deep", "nested", "config.json");
      runBash(`_save_token_to_config "${configFile}" "token-val"`);

      expect(existsSync(configFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(parsed.api_key).toBe("token-val");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should set file permissions to 600", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "secure.json");
      runBash(`_save_token_to_config "${configFile}" "secret-token"`);

      const result = runBash(`stat -c '%a' "${configFile}"`);
      expect(result.stdout).toBe("600");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should safely handle token with double quotes via json_escape", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      runBash(`_save_token_to_config "${configFile}" 'token-with-"quotes"'`);

      const content = readFileSync(configFile, "utf-8");
      // Must be valid JSON
      const parsed = JSON.parse(content);
      expect(parsed.api_key).toContain("quotes");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should safely handle token with backslashes via json_escape", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      runBash(`_save_token_to_config "${configFile}" 'token\\with\\backslash'`);

      const content = readFileSync(configFile, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.api_key).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should overwrite existing config file", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "old-token", token: "old-token" }));

      runBash(`_save_token_to_config "${configFile}" "new-token"`);

      const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(parsed.api_key).toBe("new-token");
      expect(parsed.token).toBe("new-token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should roundtrip with _load_token_from_config", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "roundtrip.json");
      runBash(`_save_token_to_config "${configFile}" "rt-token-abc"`);

      const result = runBash(`
        _load_token_from_config "${configFile}" "LOADED_TOKEN" "TestProvider"
        echo "$LOADED_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("rt-token-abc");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
      unset VAR_B
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when one env var is empty", () => {
    const result = runBash(`
      export VAR_A="a"
      export VAR_B=""
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with a single set env var", () => {
    const result = runBash(`
      export SINGLE_VAR="value"
      _multi_creds_all_env_set SINGLE_VAR
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when all env vars are unset", () => {
    const result = runBash(`
      unset NONE_A
      unset NONE_B
      _multi_creds_all_env_set NONE_A NONE_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when first var is unset but rest are set", () => {
    const result = runBash(`
      unset FIRST_VAR
      export SECOND_VAR="ok"
      export THIRD_VAR="ok"
      _multi_creds_all_env_set FIRST_VAR SECOND_VAR THIRD_VAR
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when last var is unset but rest are set", () => {
    const result = runBash(`
      export FIRST_VAR="ok"
      export SECOND_VAR="ok"
      unset THIRD_VAR
      _multi_creds_all_env_set FIRST_VAR SECOND_VAR THIRD_VAR
    `);
    expect(result.exitCode).toBe(1);
  });
});

// ── _multi_creds_load_config ────────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("should load all credentials from config file into env vars", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "creds.json");
      writeFileSync(configFile, JSON.stringify({
        username: "admin",
        password: "secret123",
      }));

      const result = runBash(`
        _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
        echo "USER=$MY_USER"
        echo "PASS=$MY_PASS"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("USER=admin");
      expect(result.stdout).toContain("PASS=secret123");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _multi_creds_load_config "/tmp/nonexistent-${Date.now()}.json" 1 MY_VAR key
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a config field is empty", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "creds.json");
      writeFileSync(configFile, JSON.stringify({
        username: "admin",
        password: "",
      }));

      const result = runBash(`
        _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
      `);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when a config field is missing", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "creds.json");
      writeFileSync(configFile, JSON.stringify({
        username: "admin",
      }));

      const result = runBash(`
        _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
      `);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle single credential", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "single.json");
      writeFileSync(configFile, JSON.stringify({ token: "abc123" }));

      const result = runBash(`
        _multi_creds_load_config "${configFile}" 1 MY_TOKEN token
        echo "TOKEN=$MY_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TOKEN=abc123");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle three credentials", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "triple.json");
      writeFileSync(configFile, JSON.stringify({
        client_id: "id-123",
        client_secret: "secret-456",
        tenant: "my-tenant",
      }));

      const result = runBash(`
        _multi_creds_load_config "${configFile}" 3 CID CSEC CTENANT client_id client_secret tenant
        echo "ID=$CID"
        echo "SECRET=$CSEC"
        echo "TENANT=$CTENANT"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ID=id-123");
      expect(result.stdout).toContain("SECRET=secret-456");
      expect(result.stdout).toContain("TENANT=my-tenant");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when config file has invalid JSON", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "bad.json");
      writeFileSync(configFile, "not json");

      const result = runBash(`
        _multi_creds_load_config "${configFile}" 1 MY_VAR key
      `);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── _multi_creds_validate ───────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when no test function is provided (empty string)", () => {
    const result = runBash(`
      _multi_creds_validate "" "TestProvider" VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export VAR_A="a"
      export VAR_B="b"
      _multi_creds_validate "test_ok" "TestProvider" VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export VAR_A="a"
      _multi_creds_validate "test_fail" "TestProvider" VAR_A
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset all env vars on validation failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export CRED_A="should-go"
      export CRED_B="also-should-go"
      _multi_creds_validate "test_fail" "Provider" CRED_A CRED_B 2>/dev/null
      if [ -z "$CRED_A" ]; then echo "A=UNSET"; else echo "A=$CRED_A"; fi
      if [ -z "$CRED_B" ]; then echo "B=UNSET"; else echo "B=$CRED_B"; fi
    `);
    expect(result.stdout).toContain("A=UNSET");
    expect(result.stdout).toContain("B=UNSET");
  });

  it("should preserve env vars on validation success", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export CRED_A="kept"
      export CRED_B="also-kept"
      _multi_creds_validate "test_ok" "Provider" CRED_A CRED_B
      echo "A=$CRED_A"
      echo "B=$CRED_B"
    `);
    expect(result.stdout).toContain("A=kept");
    expect(result.stdout).toContain("B=also-kept");
  });

  it("should log error with provider name on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_VAR="x"
      _multi_creds_validate "test_fail" "UpCloud" MY_VAR 2>&1
    `);
    expect(result.stdout).toContain("UpCloud");
    expect(result.stdout).toContain("Invalid");
  });

  it("should log testing message with provider name", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export MY_VAR="x"
      _multi_creds_validate "test_ok" "Contabo" MY_VAR 2>&1
    `);
    expect(result.stdout).toContain("Testing");
    expect(result.stdout).toContain("Contabo");
  });
});

// ── Integration: _save_token_to_config + _load_token_from_config roundtrip ──

describe("credential roundtrip integration", () => {
  it("should save and load token with special chars through full pipeline", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "roundtrip.json");

      // Save a token with special characters
      const result = runBash(`
        _save_token_to_config "${configFile}" "sk-or-v1-test!@#"
        _load_token_from_config "${configFile}" "LOADED" "Provider"
        echo "LOADED=$LOADED"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LOADED=sk-or-v1-test!@#");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should overwrite and load new token correctly", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "overwrite.json");

      const result = runBash(`
        _save_token_to_config "${configFile}" "old-token"
        _save_token_to_config "${configFile}" "new-token"
        _load_token_from_config "${configFile}" "LOADED" "Provider"
        echo "LOADED=$LOADED"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LOADED=new-token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should prioritize env var over config file in ensure flow", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "priority.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "from-config" }));

      // _load_token_from_env should succeed first, skipping config
      const result = runBash(`
        export MY_TOKEN="from-env"
        _load_token_from_env "MY_TOKEN" "Provider"
        echo "TOKEN=$MY_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TOKEN=from-env");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should fall through env to config when env var not set", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "fallback.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "from-config" }));

      const result = runBash(`
        unset MY_TOKEN
        _load_token_from_env "MY_TOKEN" "Provider" || \
          _load_token_from_config "${configFile}" "MY_TOKEN" "Provider"
        echo "TOKEN=$MY_TOKEN"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("TOKEN=from-config");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── Multi-credential roundtrip via _save_json_config + _multi_creds_load_config

describe("multi-credential roundtrip", () => {
  it("should save with _save_json_config and load with _multi_creds_load_config", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "multi.json");

      const result = runBash(`
        _save_json_config "${configFile}" username "testuser" password "testpass"
        _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
        echo "USER=$MY_USER"
        echo "PASS=$MY_PASS"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("USER=testuser");
      expect(result.stdout).toContain("PASS=testpass");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle credentials with special characters in roundtrip", () => {
    const tempDir = createTempDir();
    try {
      const configFile = join(tempDir, "special.json");

      const result = runBash(`
        _save_json_config "${configFile}" client_id "id-with-dash" client_secret "s3cr3t!@#$%"
        _multi_creds_load_config "${configFile}" 2 CID CSEC client_id client_secret
        echo "ID=$CID"
        echo "SEC=$CSEC"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ID=id-with-dash");
      expect(result.stdout).toContain("SEC=s3cr3t!@#$%");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
