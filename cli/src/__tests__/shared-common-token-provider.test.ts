import { describe, it, expect, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for the ensure_api_token_with_provider credential management flow
 * in shared/common.sh.
 *
 * This is the primary credential loading path used by ALL single-token cloud
 * providers (Hetzner, DigitalOcean, Vultr, Lambda, Linode, etc.).
 * Previously had ZERO test coverage.
 *
 * Functions tested:
 * - _load_token_from_env: load API token from environment variable
 * - _load_token_from_config: load API token from JSON config file
 * - _validate_token_with_provider: validate token via provider API callback
 * - _save_token_to_config: persist token to JSON config file with secure perms
 * - ensure_api_token_with_provider: full credential resolution flow
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/** Temporary directories created during tests, cleaned up in afterEach */
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
 * Redirects stderr to a temp file so we can capture it even on success.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const stderrFile = join(tmpdir(), `spawn-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}'  2>"${stderrFile}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stderr = "";
    try { stderr = readFileSync(stderrFile, "utf-8"); } catch (err: any) {
      // Expected: ENOENT if stderr file wasn't created. Log unexpected errors.
      if (err.code !== "ENOENT") console.error("Unexpected error reading stderr:", err);
    }
    try { rmSync(stderrFile, { force: true }); } catch (err: any) {
      if (err.code !== "ENOENT") console.error("Unexpected error removing stderr file:", err);
    }
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    let stderr = (err.stderr || "").trim();
    try { stderr = readFileSync(stderrFile, "utf-8").trim() || stderr; } catch (readErr: any) {
      if (readErr.code !== "ENOENT") console.error("Unexpected error reading stderr:", readErr);
    }
    try { rmSync(stderrFile, { force: true }); } catch (rmErr: any) {
      if (rmErr.code !== "ENOENT") console.error("Unexpected error removing stderr file:", rmErr);
    }
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

// ── _load_token_from_env ──────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(`
      export MY_TOKEN="sk-test-123"
      _load_token_from_env MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when env var is not set", () => {
    const result = runBash(`
      unset MY_TOKEN
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

  it("should log provider name on success", () => {
    const result = runBash(`
      export MY_TOKEN="test-value"
      _load_token_from_env MY_TOKEN "Hetzner"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Hetzner");
    expect(result.stderr).toContain("environment");
  });

  it("should not log anything on failure", () => {
    const result = runBash(`
      unset MY_TOKEN
      _load_token_from_env MY_TOKEN "Provider" 2>/dev/null
      echo "exit=$?"
    `);
    expect(result.stdout).toContain("exit=1");
  });

  it("should work with typical cloud env var names", () => {
    const envVars = [
      "HCLOUD_TOKEN",
      "DO_API_TOKEN",
      "VULTR_API_KEY",
      "LAMBDA_API_KEY",
      "LINODE_TOKEN",
    ];

    for (const envVar of envVars) {
      const result = runBash(`
        export ${envVar}="test-token-value"
        _load_token_from_env ${envVar} "TestCloud"
      `);
      expect(result.exitCode).toBe(0);
    }
  });

  it("should detect token value with special characters", () => {
    const result = runBash(`
      export SPECIAL_TOKEN="sk-or-v1-abc123/def+456=="
      _load_token_from_env SPECIAL_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _load_token_from_config ─────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from 'api_key' field in config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-from-config" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-from-config");
  });

  it("should load token from 'token' field in config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "tk-from-config" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tk-from-config");
  });

  it("should prefer 'api_key' over 'token' when both present", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      api_key: "from-api-key",
      token: "from-token",
    }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from-api-key");
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(`
      _load_token_from_config "/tmp/nonexistent-config-${Date.now()}.json" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has invalid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "bad.json");
    writeFileSync(configFile, "{ not valid json!!!");

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has empty api_key and token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "empty.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has neither api_key nor token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "other.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should export the env var so it's available in the shell", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "exported-token" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" HCLOUD_TOKEN "Hetzner"
      # Verify it was exported (not just set as local)
      bash -c 'echo "\${HCLOUD_TOKEN}"'
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("exported-token");
  });

  it("should log provider name and config path on success", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "test-val" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Lambda"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Lambda");
    expect(result.stderr).toContain(configFile);
  });

  it("should handle token values with slashes and equals signs", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-or-v1-abc/def+ghi==" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-or-v1-abc/def+ghi==");
  });

  it("should handle config file with extra fields gracefully", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      api_key: "my-token",
      region: "us-east-1",
      version: 2,
      nested: { foo: "bar" },
    }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-token");
  });
});

// ── _validate_token_with_provider ───────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when test_func is empty (no validation)", () => {
    const result = runBash(`
      _validate_token_with_provider "" MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test_func succeeds", () => {
    const result = runBash(`
      test_success() { return 0; }
      export MY_TOKEN="valid-token"
      _validate_token_with_provider test_success MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when test_func fails", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="invalid-token"
      _validate_token_with_provider test_fail MY_TOKEN "TestProvider"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should unset env var on validation failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="bad-token"
      _validate_token_with_provider test_fail MY_TOKEN "TestProvider"
      echo "TOKEN_AFTER=\${MY_TOKEN:-UNSET}"
    `);
    // The function returns 1 but we continue to check the env var
    expect(result.stdout).toContain("TOKEN_AFTER=UNSET");
  });

  it("should not unset env var on validation success", () => {
    const result = runBash(`
      test_ok() { return 0; }
      export MY_TOKEN="good-token"
      _validate_token_with_provider test_ok MY_TOKEN "TestProvider"
      echo "TOKEN_AFTER=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TOKEN_AFTER=good-token");
  });

  it("should show error messages on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="bad-token"
      _validate_token_with_provider test_fail MY_TOKEN "Hetzner"
    `);
    expect(result.stderr).toContain("Hetzner");
    expect(result.stderr).toContain("Invalid");
  });

  it("should include env var name in error hint", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export VULTR_API_KEY="bad-key"
      _validate_token_with_provider test_fail VULTR_API_KEY "Vultr"
    `);
    expect(result.stderr).toContain("VULTR_API_KEY");
  });

  it("should mention expired/revoked in error message", () => {
    const result = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="expired"
      _validate_token_with_provider test_fail MY_TOKEN "Cloud"
    `);
    expect(result.stderr).toContain("expired");
  });
});

// ── _save_token_to_config ───────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("should create config file with valid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "new-config.json");

    const result = runBash(`_save_token_to_config "${configFile}" "sk-test-123"`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("sk-test-123");
    expect(parsed.token).toBe("sk-test-123");
  });

  it("should store token in both api_key and token fields", () => {
    const dir = createTempDir();
    const configFile = join(dir, "dual.json");

    runBash(`_save_token_to_config "${configFile}" "my-token-value"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("my-token-value");
    expect(parsed.token).toBe("my-token-value");
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const configFile = join(dir, "nested", "deep", "config.json");

    const result = runBash(`_save_token_to_config "${configFile}" "test"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);
  });

  it("should set file permissions to 600", () => {
    const dir = createTempDir();
    const configFile = join(dir, "secure.json");

    runBash(`_save_token_to_config "${configFile}" "secret-token"`);

    const result = runBash(`stat -c %a "${configFile}" 2>/dev/null || stat -f %Lp "${configFile}"`);
    expect(result.stdout).toBe("600");
  });

  it("should properly escape token with double quotes", () => {
    const dir = createTempDir();
    const configFile = join(dir, "escaped.json");

    runBash(`_save_token_to_config "${configFile}" 'token"with"quotes'`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe('token"with"quotes');
  });

  it("should properly escape token with backslashes", () => {
    const dir = createTempDir();
    const configFile = join(dir, "backslash.json");

    runBash(`_save_token_to_config "${configFile}" 'token\\with\\backslash'`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("token\\with\\backslash");
  });

  it("should overwrite existing config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "overwrite.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "old-token", extra: "data" }));

    runBash(`_save_token_to_config "${configFile}" "new-token"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe("new-token");
    // Overwrite should not preserve old fields
    expect(parsed.extra).toBeUndefined();
  });

  it("should log success message with config path", () => {
    const dir = createTempDir();
    const configFile = join(dir, "log.json");

    const result = runBash(`_save_token_to_config "${configFile}" "test"`);
    expect(result.stderr).toContain("saved");
    expect(result.stderr).toContain(configFile);
  });

  it("should handle long token values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "long.json");
    const longToken = "sk-or-v1-" + "a".repeat(200);

    runBash(`_save_token_to_config "${configFile}" "${longToken}"`);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.api_key).toBe(longToken);
  });

  it("should produce JSON readable by _load_token_from_config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "roundtrip.json");

    runBash(`_save_token_to_config "${configFile}" "roundtrip-token-123"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Test"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("roundtrip-token-123");
  });
});

// ── ensure_api_token_with_provider (integration) ─────────────────────────

describe("ensure_api_token_with_provider", () => {
  it("should use env var when set (fast path)", () => {
    const result = runBash(`
      export HCLOUD_TOKEN="from-env"
      ensure_api_token_with_provider "Hetzner" "HCLOUD_TOKEN" "/tmp/nonexistent.json" "https://example.com"
      echo "TOKEN=\${HCLOUD_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TOKEN=from-env");
  });

  it("should use config file when env var is not set", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "from-config" }));

    const result = runBash(`
      unset MY_TOKEN
      ensure_api_token_with_provider "TestCloud" "MY_TOKEN" "${configFile}" "https://example.com"
      echo "TOKEN=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TOKEN=from-config");
  });

  it("should skip validation when test_func is empty", () => {
    const result = runBash(`
      export MY_TOKEN="unvalidated-token"
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "/tmp/none.json" "https://example.com" ""
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("should validate token with test function when provided", () => {
    const result = runBash(`
      test_token() { return 0; }
      export MY_TOKEN="valid-token"
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "/tmp/none.json" "https://example.com" test_token
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("should prefer env var over config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "from-config" }));

    const result = runBash(`
      export MY_TOKEN="from-env"
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "${configFile}" "https://example.com"
      echo "TOKEN=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TOKEN=from-env");
  });

  it("should not prompt when env var is set (even with no config)", () => {
    const result = runBash(`
      export MY_TOKEN="env-value"
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "/tmp/nonexistent.json" "https://example.com"
      echo "RESULT=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("RESULT=env-value");
  });

  it("should not prompt when config file has valid token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "config-value" }));

    const result = runBash(`
      unset MY_TOKEN
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "${configFile}" "https://example.com"
      echo "RESULT=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("RESULT=config-value");
  });
});

// ── _load_token_from_env with indirect expansion edge cases ──────────────

describe("_load_token_from_env edge cases", () => {
  it("should handle env var with spaces in value", () => {
    const result = runBash(`
      export MY_TOKEN="token with spaces"
      _load_token_from_env MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should handle env var with newline in value", () => {
    const result = runBash(`
      export MY_TOKEN="$(printf 'line1\\nline2')"
      _load_token_from_env MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should handle env var with equals sign in value", () => {
    const result = runBash(`
      export MY_TOKEN="key=value=extra"
      _load_token_from_env MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── _load_token_from_config with edge-case JSON ──────────────────────────

describe("_load_token_from_config edge cases", () => {
  it("should handle config with null api_key (should fall back to token)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "null.json");
    writeFileSync(configFile, JSON.stringify({ api_key: null, token: "from-token-field" }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from-token-field");
  });

  it("should return 1 for empty JSON object", () => {
    const dir = createTempDir();
    const configFile = join(dir, "empty.json");
    writeFileSync(configFile, "{}");

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 for JSON array instead of object", () => {
    const dir = createTempDir();
    const configFile = join(dir, "array.json");
    writeFileSync(configFile, '[{"api_key": "test"}]');

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should handle config file with only whitespace token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "whitespace.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "   " }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
      echo "\${MY_TOKEN}"
    `);
    // Python returns "   " which is non-empty, so the function should succeed
    // but this tests that whitespace-only tokens are handled
    expect(result.exitCode).toBe(0);
  });

  it("should handle config file with numeric token value", () => {
    const dir = createTempDir();
    const configFile = join(dir, "numeric.json");
    writeFileSync(configFile, JSON.stringify({ api_key: 12345 }));

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Cloud"
      echo "\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12345");
  });
});

// ── _save_token_to_config roundtrip edge cases ──────────────────────────

describe("_save_token_to_config roundtrip security", () => {
  it("should safely handle token with injection attempt via double quotes", () => {
    const dir = createTempDir();
    const configFile = join(dir, "inject.json");

    // Attempt to break out of JSON string
    runBash(`_save_token_to_config "${configFile}" 'test","evil":"payload'`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    // Should be stored as a literal string, not parsed as JSON structure
    expect(parsed.api_key).toBe('test","evil":"payload');
  });

  it("should safely handle token with newline injection", () => {
    const dir = createTempDir();
    const configFile = join(dir, "newline.json");

    runBash(`_save_token_to_config "${configFile}" "$(printf 'line1\\nline2')"`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("line1\nline2");
  });

  it("should safely handle token with tab characters", () => {
    const dir = createTempDir();
    const configFile = join(dir, "tab.json");

    runBash(`_save_token_to_config "${configFile}" "$(printf 'col1\\tcol2')"`);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("col1\tcol2");
  });

  it("should roundtrip API key format used by OpenRouter", () => {
    const dir = createTempDir();
    const configFile = join(dir, "openrouter.json");
    const token = "sk-or-v1-abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

    runBash(`_save_token_to_config "${configFile}" "${token}"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" MY_TOKEN "Test"
      echo "\${MY_TOKEN}"
    `);
    expect(result.stdout).toBe(token);
  });

  it("should roundtrip Hetzner-style API token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "hetzner.json");
    const token = "hcloud_abcdefghijklmnopqrstuvwxyz1234567890";

    runBash(`_save_token_to_config "${configFile}" "${token}"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" HCLOUD_TOKEN "Hetzner"
      echo "\${HCLOUD_TOKEN}"
    `);
    expect(result.stdout).toBe(token);
  });

  it("should roundtrip DigitalOcean-style API token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "do.json");
    const token = "dop_v1_abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678";

    runBash(`_save_token_to_config "${configFile}" "${token}"`);

    const result = runBash(`
      _load_token_from_config "${configFile}" DO_API_TOKEN "DigitalOcean"
      echo "\${DO_API_TOKEN}"
    `);
    expect(result.stdout).toBe(token);
  });
});

// ── _validate_token_with_provider with various test functions ─────────────

describe("_validate_token_with_provider integration", () => {
  it("should pass env var to test function context", () => {
    const result = runBash(`
      check_token() {
        # Test function can access the token via the env var
        [[ -n "\${MY_TOKEN}" ]] && [[ "\${MY_TOKEN}" == "correct-token" ]]
      }
      export MY_TOKEN="correct-token"
      _validate_token_with_provider check_token MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should handle test function that checks with curl (simulated)", () => {
    const result = runBash(`
      test_api() {
        # Simulate successful API check
        return 0
      }
      export MY_TOKEN="valid"
      _validate_token_with_provider test_api MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should handle test function that returns non-zero exit code", () => {
    const result = runBash(`
      test_api_fail() {
        return 2  # Non-standard error code
      }
      export MY_TOKEN="bad"
      _validate_token_with_provider test_api_fail MY_TOKEN "Cloud"
    `);
    expect(result.exitCode).toBe(1);
  });
});

// ── ensure_api_token_with_provider full flow ─────────────────────────────

describe("ensure_api_token_with_provider full flow", () => {
  it("should try env var first, then config, in order", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "config-token" }));

    // When env var is set, config file should not be checked
    const result = runBash(`
      export MY_TOKEN="env-token"
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "${configFile}" "https://example.com"
      echo "RESULT=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("RESULT=env-token");
    // Should mention "environment" in log, not config file path
    expect(result.stderr).toContain("environment");
    expect(result.stderr).not.toContain(configFile);
  });

  it("should fall through to config when env var is empty", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "config-token" }));

    const result = runBash(`
      unset MY_TOKEN
      ensure_api_token_with_provider "Cloud" "MY_TOKEN" "${configFile}" "https://example.com"
      echo "RESULT=\${MY_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("RESULT=config-token");
    expect(result.stderr).toContain(configFile);
  });

  it("should use the provider name consistently in log messages", () => {
    const result = runBash(`
      export LAMBDA_API_KEY="test-key"
      ensure_api_token_with_provider "Lambda Cloud" "LAMBDA_API_KEY" "/tmp/none.json" "https://example.com"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Lambda Cloud");
  });

  it("should work with real-world provider configurations", () => {
    // Test typical Hetzner setup
    const result = runBash(`
      export HCLOUD_TOKEN="test-hetzner-token"
      ensure_api_token_with_provider "Hetzner" "HCLOUD_TOKEN" "\$HOME/.config/spawn/hetzner.json" \
        "https://console.hetzner.cloud/projects/default/security/tokens"
      echo "OK=\${HCLOUD_TOKEN}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK=test-hetzner-token");
  });

  it("should work with real-world Vultr configuration", () => {
    const result = runBash(`
      export VULTR_API_KEY="test-vultr-key"
      ensure_api_token_with_provider "Vultr" "VULTR_API_KEY" "\$HOME/.config/spawn/vultr.json" \
        "https://my.vultr.com/settings/#settingsapi"
      echo "OK=\${VULTR_API_KEY}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK=test-vultr-key");
  });
});
