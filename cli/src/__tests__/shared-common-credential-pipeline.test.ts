import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";

/**
 * Tests for the credential loading pipeline in shared/common.sh.
 *
 * These functions are SECURITY-CRITICAL and called by every cloud provider
 * (19+ providers) for API token management:
 *
 * - _load_token_from_env: loads API token from environment variable
 * - _load_token_from_config: loads token from JSON config file via python3
 * - _validate_token_with_provider: validates token using provider API test function
 * - _save_token_to_config: saves token to JSON config file with json_escape + chmod 600
 * - ensure_api_token_with_provider: full credential pipeline (env -> config -> prompt -> validate -> save)
 * - _multi_creds_all_env_set: checks all env vars are set
 * - _multi_creds_load_config: loads multiple credentials from JSON config
 * - _multi_creds_validate: validates credentials, unsets on failure
 * - ensure_multi_credentials: full multi-credential pipeline
 *
 * Each test sources shared/common.sh and runs the function in a real bash
 * subprocess. This ensures actual bash behavior is tested (variable indirection,
 * python3 JSON parsing, file permissions, etc.).
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 * Uses a temp file to capture stderr so it's available even on success.
 */
function runBash(script: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const stderrFile = join(
    tmpdir(),
    `spawn-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}' 2>"${stderrFile}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        shell: "/bin/bash",
      }
    );
    let stderr = "";
    try {
      stderr = readFileSync(stderrFile, "utf-8");
    } catch {}
    try {
      rmSync(stderrFile);
    } catch {}
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    let stderr = (err.stderr || "").trim();
    try {
      const fileStderr = readFileSync(stderrFile, "utf-8").trim();
      if (fileStderr) stderr = fileStderr;
    } catch {}
    try {
      rmSync(stderrFile);
    } catch {}
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

/** Create a temporary directory for test files. */
function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _load_token_from_env ─────────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export MY_TOKEN="sk-test-123"
      _load_token_from_env MY_TOKEN "Test Provider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_env MY_TOKEN "Test Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(`
      export MY_TOKEN=""
      _load_token_from_env MY_TOKEN "Test Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should log provider name on success", () => {
    const result = runBash(`
      export MY_TOKEN="abc123"
      _load_token_from_env MY_TOKEN "Lambda Cloud"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Lambda Cloud");
  });

  it("should work with various env var names", () => {
    const varNames = [
      "HCLOUD_TOKEN",
      "DO_API_TOKEN",
      "VULTR_API_KEY",
      "LINODE_TOKEN",
    ];
    for (const varName of varNames) {
      const result = runBash(`
        export ${varName}="test-value"
        _load_token_from_env ${varName} "Provider"
      `);
      expect(result.exitCode).toBe(0);
    }
  });

  it("should handle token with special characters", () => {
    const result = runBash(`
      export MY_TOKEN='sk-or-v1-abc/def+ghi=jkl'
      _load_token_from_env MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _load_token_from_config ──────────────────────────────────────────────────

describe("_load_token_from_config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load token from JSON config with api_key field", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-test-loaded" }));

    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_config "${configFile}" MY_TOKEN "Test Provider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-test-loaded");
  });

  it("should load token from JSON config with token field", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "tk-test-456" }));

    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_config "${configFile}" MY_TOKEN "Test Provider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tk-test-456");
  });

  it("should prefer api_key over token when both present", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ api_key: "preferred-key", token: "fallback-key" })
    );

    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_config "${configFile}" MY_TOKEN "Provider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("preferred-key");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/tmp/nonexistent-config-${Date.now()}.json" MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has no api_key or token", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ username: "user", password: "pass" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file contains invalid JSON", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, "not valid json {{{");

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when api_key is empty string", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should export the env var with correct name", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "test-export" }));

    const result = runBash(`
      unset HCLOUD_TOKEN 2>/dev/null
      _load_token_from_config "${configFile}" HCLOUD_TOKEN "Hetzner"
      echo "$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test-export");
  });

  it("should log config file path on success", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "key123" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Lambda"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(configFile);
  });
});

// ── _validate_token_with_provider ────────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when no test function provided (empty string)", () => {
    const result = runBash(`
      _validate_token_with_provider "" MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      my_test_func() { return 0; }
      export MY_TOKEN="good-token"
      _validate_token_with_provider my_test_func MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      my_test_func() { return 1; }
      export MY_TOKEN="bad-token"
      _validate_token_with_provider my_test_func MY_TOKEN "Provider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset env var when validation fails", () => {
    const result = runBash(
      'my_test_func() { return 1; }\n' +
      'export MY_TOKEN="should-be-unset"\n' +
      '_validate_token_with_provider my_test_func MY_TOKEN "Provider"\n' +
      'echo "TOKEN_VALUE=[${MY_TOKEN:-UNSET}]"'
    );
    // Even though _validate_token_with_provider returns 1, we check stdout
    // The exitCode reflects the function itself failing
    expect(result.stdout).toContain("TOKEN_VALUE=[UNSET]");
  });

  it("should show error message with provider name on failure", () => {
    const result = runBash(`
      my_test_func() { return 1; }
      export MY_TOKEN="bad"
      _validate_token_with_provider my_test_func MY_TOKEN "Hetzner Cloud"
    `);
    expect(result.stderr).toContain("Hetzner Cloud");
    expect(result.stderr).toContain("Authentication failed");
  });

  it("should show how-to-fix message with env var name on failure", () => {
    const result = runBash(`
      my_test_func() { return 1; }
      export HCLOUD_TOKEN="bad"
      _validate_token_with_provider my_test_func HCLOUD_TOKEN "Hetzner"
    `);
    expect(result.stderr).toContain("HCLOUD_TOKEN");
  });
});

// ── _save_token_to_config ────────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should create config file with correct JSON structure", () => {
    const configFile = join(tempDir, "test-config.json");

    runBash(`_save_token_to_config "${configFile}" "my-api-key-123"`);

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.api_key).toBe("my-api-key-123");
    expect(content.token).toBe("my-api-key-123");
  });

  it("should create parent directories if needed", () => {
    const configFile = join(tempDir, "nested", "deep", "config.json");

    const result = runBash(
      `_save_token_to_config "${configFile}" "test-token"`
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);
  });

  it("should set file permissions to 600", () => {
    const configFile = join(tempDir, "secure.json");

    runBash(`_save_token_to_config "${configFile}" "secret-token"`);

    const { execSync: es } = require("child_process");
    const perms = es(`stat -c '%a' "${configFile}"`, { encoding: "utf-8" }).trim();
    expect(perms).toBe("600");
  });

  it("should properly escape special characters in token via json_escape", () => {
    const configFile = join(tempDir, "escape-test.json");

    runBash(`_save_token_to_config "${configFile}" 'token-with"quotes'`);

    const content = readFileSync(configFile, "utf-8");
    // Should be valid JSON despite special characters
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('token-with"quotes');
  });

  it("should handle token with backslashes", () => {
    const configFile = join(tempDir, "backslash-test.json");

    runBash(`_save_token_to_config "${configFile}" 'token\\with\\backslashes'`);

    const content = readFileSync(configFile, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toContain("token");
  });

  it("should overwrite existing config file", () => {
    const configFile = join(tempDir, "overwrite.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "old-key" }));

    runBash(`_save_token_to_config "${configFile}" "new-key"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("new-key");
  });

  it("should log success message with config path", () => {
    const configFile = join(tempDir, "log-test.json");

    const result = runBash(
      `_save_token_to_config "${configFile}" "test-token"`
    );
    expect(result.stderr).toContain(configFile);
    expect(result.stderr).toContain("saved");
  });
});

// ── ensure_api_token_with_provider (integration) ─────────────────────────────

describe("ensure_api_token_with_provider", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should succeed when env var is already set", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export HCLOUD_TOKEN="env-token-123"
      ensure_api_token_with_provider "Hetzner" HCLOUD_TOKEN "${configFile}" "https://hetzner.com" ""
      echo "TOKEN=$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("TOKEN=env-token-123");
  });

  it("should load token from config file when env var not set", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "config-token" }));

    const result = runBash(`
      unset HCLOUD_TOKEN 2>/dev/null
      ensure_api_token_with_provider "Hetzner" HCLOUD_TOKEN "${configFile}" "https://hetzner.com" ""
      echo "TOKEN=$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("TOKEN=config-token");
  });

  it("should prefer env var over config file", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "config-token" }));

    const result = runBash(`
      export HCLOUD_TOKEN="env-token"
      ensure_api_token_with_provider "Hetzner" HCLOUD_TOKEN "${configFile}" "https://hetzner.com" ""
      echo "TOKEN=$HCLOUD_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("TOKEN=env-token");
  });

  it("should succeed with test function that passes", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      test_my_token() { return 0; }
      export MY_TOKEN="valid-token"
      ensure_api_token_with_provider "MyCloud" MY_TOKEN "${configFile}" "https://example.com" test_my_token
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should skip validation when test function is empty", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export MY_TOKEN="any-token"
      ensure_api_token_with_provider "MyCloud" MY_TOKEN "${configFile}" "https://example.com" ""
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should skip validation when test function is omitted", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export MY_TOKEN="any-token"
      ensure_api_token_with_provider "MyCloud" MY_TOKEN "${configFile}" "https://example.com"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should not prompt when env var is set", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export MY_TOKEN="pre-set-token"
      ensure_api_token_with_provider "Provider" MY_TOKEN "${configFile}" "https://example.com" ""
    `);
    // Should not show "Required" prompt message since token already exists
    expect(result.stderr).not.toContain("Required");
    expect(result.exitCode).toBe(0);
  });

  it("should not prompt when config file has token", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "saved-token" }));

    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      ensure_api_token_with_provider "Provider" MY_TOKEN "${configFile}" "https://example.com" ""
    `);
    expect(result.stderr).not.toContain("Required");
    expect(result.exitCode).toBe(0);
  });
});

// ── _multi_creds_all_env_set ─────────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(`
      export VAR_A="value_a"
      export VAR_B="value_b"
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when any env var is not set", () => {
    const result = runBash(`
      export VAR_A="value_a"
      unset VAR_B 2>/dev/null
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when any env var is empty", () => {
    const result = runBash(`
      export VAR_A="value_a"
      export VAR_B=""
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 for single set env var", () => {
    const result = runBash(`
      export SINGLE_VAR="val"
      _multi_creds_all_env_set SINGLE_VAR
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when first var is unset", () => {
    const result = runBash(`
      unset VAR_A 2>/dev/null
      export VAR_B="val"
      _multi_creds_all_env_set VAR_A VAR_B
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 when three vars are all set", () => {
    const result = runBash(`
      export A="1"
      export B="2"
      export C="3"
      _multi_creds_all_env_set A B C
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when middle var of three is empty", () => {
    const result = runBash(`
      export A="1"
      export B=""
      export C="3"
      _multi_creds_all_env_set A B C
    `);
    expect(result.exitCode).toBe(1);
  });
});

// ── _multi_creds_load_config ─────────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should load two credentials from config file", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "user1", password: "pass1" })
    );

    const result = runBash(`
      unset MY_USER MY_PASS 2>/dev/null
      _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=user1");
    expect(result.stdout).toContain("PASS=pass1");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _multi_creds_load_config "/tmp/nonexistent-${Date.now()}.json" 2 MY_USER MY_PASS username password
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when any field is missing from config", () => {
    const configFile = join(tempDir, "partial.json");
    writeFileSync(configFile, JSON.stringify({ username: "user1" }));

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config has empty values", () => {
    const configFile = join(tempDir, "empty-vals.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "user1", password: "" })
    );

    const result = runBash(`
      _multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should load three credentials from config file", () => {
    const configFile = join(tempDir, "triple.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        client_id: "cid",
        client_secret: "csec",
        api_password: "apwd",
      })
    );

    const result = runBash(`
      unset CID CSEC APWD 2>/dev/null
      _multi_creds_load_config "${configFile}" 3 CID CSEC APWD client_id client_secret api_password
      echo "CID=$CID"
      echo "CSEC=$CSEC"
      echo "APWD=$APWD"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CID=cid");
    expect(result.stdout).toContain("CSEC=csec");
    expect(result.stdout).toContain("APWD=apwd");
  });
});

// ── _multi_creds_validate ────────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_creds() { return 0; }
      export MY_USER="user"
      export MY_PASS="pass"
      _multi_creds_validate test_creds "Provider" MY_USER MY_PASS
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test function is empty string (no validation)", () => {
    const result = runBash(`
      _multi_creds_validate "" "Provider" MY_USER MY_PASS
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test function fails", () => {
    const result = runBash(`
      test_creds() { return 1; }
      export MY_USER="user"
      export MY_PASS="pass"
      _multi_creds_validate test_creds "Provider" MY_USER MY_PASS
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset all env vars when validation fails", () => {
    const result = runBash(
      'test_creds() { return 1; }\n' +
      'export MY_USER="user"\n' +
      'export MY_PASS="pass"\n' +
      '_multi_creds_validate test_creds "Provider" MY_USER MY_PASS\n' +
      'echo "USER=[${MY_USER:-UNSET}]"\n' +
      'echo "PASS=[${MY_PASS:-UNSET}]"'
    );
    expect(result.stdout).toContain("USER=[UNSET]");
    expect(result.stdout).toContain("PASS=[UNSET]");
  });

  it("should show error message with provider name on failure", () => {
    const result = runBash(`
      test_creds() { return 1; }
      _multi_creds_validate test_creds "UpCloud" VAR_A VAR_B
    `);
    expect(result.stderr).toContain("UpCloud");
    expect(result.stderr).toContain("Invalid");
  });

  it("should not unset env vars when validation succeeds", () => {
    const result = runBash(`
      test_creds() { return 0; }
      export MY_USER="keep-user"
      export MY_PASS="keep-pass"
      _multi_creds_validate test_creds "Provider" MY_USER MY_PASS
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
    `);
    expect(result.stdout).toContain("USER=keep-user");
    expect(result.stdout).toContain("PASS=keep-pass");
  });
});

// ── ensure_multi_credentials (integration) ───────────────────────────────────

describe("ensure_multi_credentials", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should succeed when all env vars are already set", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export MY_USER="env-user"
      export MY_PASS="env-pass"
      ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
        "MY_USER:username:Username" "MY_PASS:password:Password"
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=env-user");
    expect(result.stdout).toContain("PASS=env-pass");
  });

  it("should load credentials from config file", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "cfg-user", password: "cfg-pass" })
    );

    const result = runBash(`
      unset MY_USER MY_PASS 2>/dev/null
      ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
        "MY_USER:username:Username" "MY_PASS:password:Password"
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=cfg-user");
    expect(result.stdout).toContain("PASS=cfg-pass");
  });

  it("should prefer env vars over config file", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "cfg-user", password: "cfg-pass" })
    );

    const result = runBash(`
      export MY_USER="env-user"
      export MY_PASS="env-pass"
      ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
        "MY_USER:username:Username" "MY_PASS:password:Password"
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=env-user");
    expect(result.stdout).toContain("PASS=env-pass");
  });

  it("should succeed with validation function that passes", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      test_cloud_creds() { return 0; }
      export MY_USER="user"
      export MY_PASS="pass"
      ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" test_cloud_creds \
        "MY_USER:username:Username" "MY_PASS:password:Password"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should not prompt when env vars are set", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export MY_USER="user"
      export MY_PASS="pass"
      ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
        "MY_USER:username:Username" "MY_PASS:password:Password"
    `);
    expect(result.stderr).not.toContain("Required");
    expect(result.exitCode).toBe(0);
  });

  it("should parse triple-colon spec correctly", () => {
    const configFile = join(tempDir, "config.json");

    const result = runBash(`
      export CONTABO_CID="my-client-id"
      export CONTABO_CSEC="my-secret"
      export CONTABO_APWD="my-password"
      ensure_multi_credentials "Contabo" "${configFile}" "https://contabo.com" "" \
        "CONTABO_CID:client_id:Client ID" \
        "CONTABO_CSEC:client_secret:Client Secret" \
        "CONTABO_APWD:api_password:API Password"
      echo "CID=$CONTABO_CID"
      echo "CSEC=$CONTABO_CSEC"
      echo "APWD=$CONTABO_APWD"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CID=my-client-id");
    expect(result.stdout).toContain("CSEC=my-secret");
    expect(result.stdout).toContain("APWD=my-password");
  });

  it("should fall through to config when only some env vars set", () => {
    const configFile = join(tempDir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "cfg-user", password: "cfg-pass" })
    );

    const result = runBash(`
      export MY_USER="env-user"
      unset MY_PASS 2>/dev/null
      ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
        "MY_USER:username:Username" "MY_PASS:password:Password"
      echo "USER=$MY_USER"
      echo "PASS=$MY_PASS"
    `);
    // Should load from config since not ALL env vars are set
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USER=cfg-user");
    expect(result.stdout).toContain("PASS=cfg-pass");
  });
});

// ── Round-trip: save then load ───────────────────────────────────────────────

describe("credential round-trip: save then load", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should round-trip a token through save and load", () => {
    const configFile = join(tempDir, "roundtrip.json");
    const testToken = "sk-or-v1-abcdef123456";

    // Save
    runBash(`_save_token_to_config "${configFile}" "${testToken}"`);

    // Load
    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_config "${configFile}" MY_TOKEN "Provider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(testToken);
  });

  it("should round-trip a token with special chars through save and load", () => {
    const configFile = join(tempDir, "special-roundtrip.json");

    // Save a token with quotes - this tests json_escape integration
    runBash(`_save_token_to_config "${configFile}" 'key-with-special/chars+and=more'`);

    // Load
    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      _load_token_from_config "${configFile}" MY_TOKEN "Provider"
      echo "$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("key-with-special/chars+and=more");
  });

  it("should round-trip via ensure_api_token_with_provider pipeline", () => {
    const configFile = join(tempDir, "pipeline-roundtrip.json");
    const token = "test-pipeline-token";

    // First call: set env var, which should save to config
    // (ensure_api_token_with_provider returns early when env var is set,
    // but we can simulate the save path by saving first)
    runBash(`_save_token_to_config "${configFile}" "${token}"`);

    // Second call: no env var, should load from config
    const result = runBash(`
      unset MY_TOKEN 2>/dev/null
      ensure_api_token_with_provider "TestProvider" MY_TOKEN "${configFile}" "https://example.com" ""
      echo "TOKEN=$MY_TOKEN"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`TOKEN=${token}`);
  });
});
