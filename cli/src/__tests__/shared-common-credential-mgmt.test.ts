import { describe, it, expect, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management functions in shared/common.sh.
 *
 * These functions had zero test coverage despite being used by every cloud
 * provider script. They handle API token loading from env vars, config files,
 * validation via provider test functions, and saving with proper permissions.
 *
 * Functions tested:
 * - _load_token_from_env: load token from environment variable
 * - _load_token_from_config: load token from JSON config file (api_key or token field)
 * - _validate_token_with_provider: validate token via a test function
 * - _save_token_to_config: save token to JSON config with chmod 600
 * - _multi_creds_all_env_set: check if all env vars are set
 * - _multi_creds_load_config: load multiple credentials from JSON config
 * - _multi_creds_validate: validate credentials via test function, unset on failure
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

function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

function trackTempDir(): string {
  const dir = createTempDir();
  tempDirs.push(dir);
  return dir;
}

// ── _load_token_from_env ──────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export MY_TOKEN="test-token-123"
      _load_token_from_env MY_TOKEN "TestProvider"
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_env MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export MY_TOKEN=""
      _load_token_from_env MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should log info message when token found", () => {
    const result = runBash(`
      export MY_TOKEN="abc"
      _load_token_from_env MY_TOKEN "Hetzner" 2>&1
    `);
    expect(result.stdout).toContain("Hetzner");
    expect(result.stdout).toContain("environment");
  });

  it("should work with different env var names", () => {
    const result = runBash(`
      export HCLOUD_TOKEN="hetzner-token-value"
      _load_token_from_env HCLOUD_TOKEN "Hetzner Cloud"
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should handle tokens with special characters", () => {
    const result = runBash(`
      export MY_TOKEN="sk-or-v1-abc123/def+ghi="
      _load_token_from_env MY_TOKEN "Provider"
      echo "exit=$?"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _load_token_from_config ───────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from api_key field in JSON config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "my-api-key-123" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("my-api-key-123");
  });

  it("should load token from token field in JSON config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ token: "my-token-456" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("my-token-456");
  });

  it("should prefer api_key over token when both present", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "api-key-value", token: "token-value" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("api-key-value");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/nonexistent/path/config.json" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has empty api_key and empty token", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 for invalid JSON", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, "not valid json {{{");

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when JSON has no api_key or token field", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ username: "user", password: "pass" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should export the env var with the loaded value", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "loaded-token" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" HCLOUD_TOKEN "Hetzner"
      echo "HCLOUD_TOKEN=$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("HCLOUD_TOKEN=loaded-token");
  });

  it("should log info message with config file path", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "test" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider" 2>&1
    `);
    expect(result.stdout).toContain(configFile);
    expect(result.stdout).toContain("TestProvider");
  });

  it("should fall back to token field when api_key is empty", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "fallback-token" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fallback-token");
  });
});

// ── _validate_token_with_provider ─────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when no test function provided (empty string)", () => {
    const result = runBash(`
      _validate_token_with_provider "" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_success() { return 0; }
      export MY_TOKEN="valid-token"
      _validate_token_with_provider test_success MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="invalid-token"
      _validate_token_with_provider test_fail MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset the env var when validation fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="will-be-unset"
      _validate_token_with_provider test_fail MY_TOKEN "TestProvider" 2>/dev/null
      echo "MY_TOKEN=\${MY_TOKEN:-UNSET}"
    `);
    expect(result.stdout).toContain("MY_TOKEN=UNSET");
  });

  it("should log authentication failed message on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="bad"
      _validate_token_with_provider test_fail MY_TOKEN "Lambda" 2>&1
    `);
    expect(result.stdout).toContain("Authentication failed");
    expect(result.stdout).toContain("Lambda");
  });

  it("should not unset env var when validation succeeds", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export MY_TOKEN="good-token"
      _validate_token_with_provider test_ok MY_TOKEN "TestProvider"
      echo "MY_TOKEN=$MY_TOKEN"
    `);
    expect(result.stdout).toContain("MY_TOKEN=good-token");
  });
});

// ── _save_token_to_config ─────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("should create config file with api_key and token fields", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "subdir", "provider.json");

    runBash(`_save_token_to_config "${configFile}" "my-secret-token" 2>/dev/null`);

    expect(existsSync(configFile)).toBe(true);
    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("my-secret-token");
    expect(parsed.token).toBe("my-secret-token");
  });

  it("should create parent directories if they do not exist", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "deep", "nested", "config.json");

    runBash(`_save_token_to_config "${configFile}" "test-token" 2>/dev/null`);

    expect(existsSync(configFile)).toBe(true);
  });

  it("should set file permissions to 600", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "secure.json");

    runBash(`_save_token_to_config "${configFile}" "secret" 2>/dev/null`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });

  it("should properly JSON-escape tokens with special characters", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "special.json");

    // Token with quotes and backslashes
    runBash(`_save_token_to_config "${configFile}" 'token-with-"quotes"' 2>/dev/null`);

    const content = readFileSync(configFile, "utf-8");
    // Should be valid JSON
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('token-with-"quotes"');
  });

  it("should overwrite existing config file", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "provider.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "old-token" }));

    runBash(`_save_token_to_config "${configFile}" "new-token" 2>/dev/null`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("new-token");
  });

  it("should write valid JSON that can be re-read by _load_token_from_config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "roundtrip.json");

    // Save token
    runBash(`_save_token_to_config "${configFile}" "roundtrip-value" 2>/dev/null`);

    // Load it back
    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED_TOKEN "Test" 2>/dev/null
      echo "$LOADED_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("roundtrip-value");
  });

  it("should handle empty token string", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "empty.json");

    runBash(`_save_token_to_config "${configFile}" "" 2>/dev/null`);

    expect(existsSync(configFile)).toBe(true);
    const content = readFileSync(configFile, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("");
  });
});

// ── _multi_creds_all_env_set ──────────────────────────────────────────────

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

  it("should return 1 when any env var is missing", () => {
    const result = runBash(`
      export VAR_A="a"
      unset VAR_B 2>/dev/null
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when any env var is empty string", () => {
    const result = runBash(`
      export VAR_A="a"
      export VAR_B=""
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with a single env var that is set", () => {
    const result = runBash(`
      export SINGLE_VAR="value"
      _multi_creds_all_env_set SINGLE_VAR
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when first env var is missing but second is set", () => {
    const result = runBash(`
      unset FIRST_VAR 2>/dev/null
      export SECOND_VAR="present"
      _multi_creds_all_env_set FIRST_VAR SECOND_VAR
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when last env var is missing", () => {
    const result = runBash(`
      export VAR_A="a"
      export VAR_B="b"
      unset VAR_C 2>/dev/null
      _multi_creds_all_env_set VAR_A VAR_B VAR_C
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

// ── _multi_creds_load_config ──────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("should load two credentials from JSON config into env vars", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "multi.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "my-client-id",
      client_secret: "my-secret",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 CRED_ID CRED_SECRET client_id client_secret
      echo "ID=$CRED_ID"
      echo "SECRET=$CRED_SECRET"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ID=my-client-id");
    expect(result.stdout).toContain("SECRET=my-secret");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _multi_creds_load_config "/nonexistent/config.json" 1 MY_VAR my_key
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a field is empty in config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "partial.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "has-value",
      client_secret: "",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 CRED_ID CRED_SECRET client_id client_secret
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a field is missing from config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "missing.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "has-value",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 CRED_ID CRED_SECRET client_id client_secret
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should load a single credential from config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "single.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "single-value" }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 1 MY_KEY api_key
      echo "KEY=$MY_KEY"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("KEY=single-value");
  });

  it("should load three credentials from config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "three.json");
    writeFileSync(configFile, JSON.stringify({
      username: "user1",
      password: "pass1",
      project: "proj1",
    }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 3 MY_USER MY_PASS MY_PROJ username password project
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
      echo "PROJ=$MY_PROJ"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=user1");
    expect(result.stdout).toContain("PASS=pass1");
    expect(result.stdout).toContain("PROJ=proj1");
  });

  it("should return 1 for invalid JSON config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "invalid.json");
    writeFileSync(configFile, "not json {{{");

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 1 MY_VAR my_key
    `);
    expect(result.exitCode).toBe(1);
  });
});

// ── _multi_creds_validate ─────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when no test function provided (empty string)", () => {
    const result = runBash(`
      _multi_creds_validate "" "TestProvider" VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export VAR_A="a"
      _multi_creds_validate test_ok "TestProvider" VAR_A
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export VAR_A="a"
      _multi_creds_validate test_fail "TestProvider" VAR_A 2>/dev/null
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset all env vars when validation fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export VAR_A="a"
      export VAR_B="b"
      _multi_creds_validate test_fail "TestProvider" VAR_A VAR_B 2>/dev/null
      echo "A=\${VAR_A:-UNSET}"
      echo "B=\${VAR_B:-UNSET}"
    `);
    expect(result.stdout).toContain("A=UNSET");
    expect(result.stdout).toContain("B=UNSET");
  });

  it("should not unset env vars when validation succeeds", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export VAR_A="kept"
      export VAR_B="also-kept"
      _multi_creds_validate test_ok "TestProvider" VAR_A VAR_B 2>/dev/null
      echo "A=$VAR_A"
      echo "B=$VAR_B"
    `);
    expect(result.stdout).toContain("A=kept");
    expect(result.stdout).toContain("B=also-kept");
  });

  it("should log error message with provider name on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export VAR_A="a"
      _multi_creds_validate test_fail "Contabo" VAR_A 2>&1
    `);
    expect(result.stdout).toContain("Contabo");
    expect(result.stdout).toContain("Invalid");
  });
});

// ── Integration: _save_token_to_config + _load_token_from_config ──────────

describe("credential roundtrip integration", () => {
  it("should save and reload a simple token", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "roundtrip.json");

    // Save
    runBash(`_save_token_to_config "${configFile}" "abc123" 2>/dev/null`);

    // Load
    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED "Test" 2>/dev/null
      echo "$LOADED"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abc123");
  });

  it("should save and reload a token with special JSON characters", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "special.json");

    // Save a token with backslash and newline-like content
    runBash(`_save_token_to_config "${configFile}" 'token\\with\\slashes' 2>/dev/null`);

    // Load it back
    const result = runBash(`
      _load_token_from_config "${configFile}" LOADED "Test" 2>/dev/null
      echo "$LOADED"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("token");
  });

  it("should validate after loading from config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "validated.json");

    // Save
    runBash(`_save_token_to_config "${configFile}" "valid-token" 2>/dev/null`);

    // Load and validate
    const result = runBash(`
      test_valid() { [[ "$MY_TOKEN" == "valid-token" ]]; }
      _load_token_from_config "${configFile}" MY_TOKEN "Test" 2>/dev/null
      _validate_token_with_provider test_valid MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── Integration: multi-credential save and load ───────────────────────────

describe("multi-credential save and load integration", () => {
  it("should save with _save_json_config and load with _multi_creds_load_config", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "multi-roundtrip.json");

    // Save two credentials
    runBash(`_save_json_config "${configFile}" client_id "my-id" client_secret "my-secret" 2>/dev/null`);

    // Load them back
    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 LOADED_ID LOADED_SECRET client_id client_secret
      echo "ID=$LOADED_ID"
      echo "SECRET=$LOADED_SECRET"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ID=my-id");
    expect(result.stdout).toContain("SECRET=my-secret");
  });

  it("should save three credentials and load all three", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "three-creds.json");

    runBash(`_save_json_config "${configFile}" username "user" password "pass" project_id "proj" 2>/dev/null`);

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 3 U P R username password project_id
      echo "U=$U P=$P R=$R"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("U=user");
    expect(result.stdout).toContain("P=pass");
    expect(result.stdout).toContain("R=proj");
  });

  it("should save config with chmod 600", () => {
    const dir = trackTempDir();
    const configFile = join(dir, "perms.json");

    runBash(`_save_json_config "${configFile}" key "value" 2>/dev/null`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });
});
