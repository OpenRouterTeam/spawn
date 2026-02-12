import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management functions in shared/common.sh:
 *
 * - _load_token_from_env: loads API token from environment variable
 * - _load_token_from_config: loads token from JSON config file (api_key or token field)
 * - _save_token_to_config: saves token to JSON config file with json_escape + chmod 600
 * - _validate_token_with_provider: validates token via callback, unsets on failure
 * - _multi_creds_all_env_set: checks if all env vars are non-empty
 * - _multi_creds_load_config: loads multiple credentials from JSON config
 * - _multi_creds_validate: validates multi-credentials via callback, unsets on failure
 * - _save_json_config: saves key-value pairs to JSON config file
 * - _load_json_config_fields: loads multiple fields from JSON config in single call
 *
 * These functions are used by every cloud provider script and had zero test coverage.
 * Each test sources shared/common.sh and runs the function in a real bash subprocess.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(
  script: string,
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const escapedScript = fullScript.replace(/'/g, "'\\''");
  try {
    const stdout = execSync(`bash -c '${escapedScript}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TERM: "dumb",
        ...env,
      },
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

describe("Credential Management Functions (shared/common.sh)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── _load_token_from_env ──────────────────────────────────────────────────

  describe("_load_token_from_env", () => {
    it("should return 0 when env var is set", () => {
      const result = runBash(
        '_load_token_from_env MY_TOKEN "TestProvider"',
        { MY_TOKEN: "sk-test-123" }
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 when env var is empty", () => {
      const result = runBash(
        '_load_token_from_env MY_TOKEN "TestProvider"',
        { MY_TOKEN: "" }
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when env var is not set", () => {
      const result = runBash(
        'unset MY_TOKEN; _load_token_from_env MY_TOKEN "TestProvider"'
      );
      expect(result.exitCode).toBe(1);
    });

    it("should log provider name when token found", () => {
      const result = runBash(
        '_load_token_from_env MY_TOKEN "Hetzner" 2>&1',
        { MY_TOKEN: "abc" }
      );
      expect(result.stdout).toContain("Hetzner");
    });
  });

  // ── _load_token_from_config ──────────────────────────────────────────────

  describe("_load_token_from_config", () => {
    it("should load token from api_key field", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "sk-from-config" }));

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider" && echo "$MY_TOKEN"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("sk-from-config");
    });

    it("should load token from token field", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ token: "tk-from-config" }));

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider" && echo "$MY_TOKEN"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("tk-from-config");
    });

    it("should prefer api_key over token when both present", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "from-api-key", token: "from-token" }));

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider" && echo "$MY_TOKEN"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("from-api-key");
    });

    it("should return 1 when config file does not exist", () => {
      const result = runBash(
        '_load_token_from_config "/nonexistent/file.json" MY_TOKEN "TestProvider"'
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when config has empty token", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when config has no token fields", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ other_field: "value" }));

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 for corrupted JSON", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, "not json {{{");

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
      );
      expect(result.exitCode).toBe(1);
    });

    it("should export the env var when token found", () => {
      const configFile = join(tempDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "export-test" }));

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_EXPORT_VAR "TestProvider" && echo "$MY_EXPORT_VAR"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export-test");
    });
  });

  // ── _save_token_to_config ─────────────────────────────────────────────────

  describe("_save_token_to_config", () => {
    it("should create config file with token", () => {
      const configFile = join(tempDir, "new-config.json");

      const result = runBash(
        `_save_token_to_config "${configFile}" "my-secret-token" 2>&1`
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(configFile)).toBe(true);

      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.api_key).toBe("my-secret-token");
      expect(content.token).toBe("my-secret-token");
    });

    it("should create parent directories if missing", () => {
      const configFile = join(tempDir, "nested", "deep", "config.json");

      const result = runBash(
        `_save_token_to_config "${configFile}" "nested-token" 2>&1`
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(configFile)).toBe(true);
    });

    it("should set file permissions to 600", () => {
      const configFile = join(tempDir, "perms-config.json");

      runBash(`_save_token_to_config "${configFile}" "perm-token" 2>&1`);

      const stats = statSync(configFile);
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe("600");
    });

    it("should properly escape special characters in token", () => {
      const configFile = join(tempDir, "escape-config.json");
      // Token with quotes, backslashes, and other special chars
      const specialToken = 'token-with-"quotes"-and-\\backslash';

      runBash(
        `_save_token_to_config "${configFile}" '${specialToken.replace(/'/g, "'\\''")}' 2>&1`
      );
      expect(existsSync(configFile)).toBe(true);

      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.api_key).toBe(specialToken);
    });

    it("should overwrite existing config file", () => {
      const configFile = join(tempDir, "overwrite.json");
      writeFileSync(configFile, JSON.stringify({ api_key: "old-token" }));

      runBash(`_save_token_to_config "${configFile}" "new-token" 2>&1`);

      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.api_key).toBe("new-token");
    });
  });

  // ── _validate_token_with_provider ─────────────────────────────────────────

  describe("_validate_token_with_provider", () => {
    it("should return 0 when test_func is empty (no validation)", () => {
      const result = runBash(
        '_validate_token_with_provider "" MY_TOKEN "TestProvider"'
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 when test function succeeds", () => {
      const result = runBash(
        'test_pass() { return 0; }; _validate_token_with_provider test_pass MY_TOKEN "TestProvider"'
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 when test function fails", () => {
      const result = runBash(
        'export MY_TOKEN=abc; test_fail() { return 1; }; _validate_token_with_provider test_fail MY_TOKEN "TestProvider" 2>&1; echo "exit=$?"',
      );
      // The function returns 1
      expect(result.stdout).toContain("exit=1");
    });

    it("should unset env var on validation failure", () => {
      const result = runBash(
        'export MY_TOKEN=abc; test_fail() { return 1; }; _validate_token_with_provider test_fail MY_TOKEN "TestProvider" 2>/dev/null; echo "val=${MY_TOKEN:-UNSET}"'
      );
      expect(result.stdout).toContain("val=UNSET");
    });

    it("should show error message on validation failure", () => {
      const result = runBash(
        'export MY_TOKEN=abc; test_fail() { return 1; }; _validate_token_with_provider test_fail MY_TOKEN "Lambda" 2>&1'
      );
      expect(result.stdout).toContain("Authentication failed");
      expect(result.stdout).toContain("Lambda");
    });
  });

  // ── _multi_creds_all_env_set ──────────────────────────────────────────────

  describe("_multi_creds_all_env_set", () => {
    it("should return 0 when all env vars are set", () => {
      const result = runBash(
        '_multi_creds_all_env_set VAR_A VAR_B',
        { VAR_A: "value-a", VAR_B: "value-b" }
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 when first env var is empty", () => {
      const result = runBash(
        '_multi_creds_all_env_set VAR_A VAR_B',
        { VAR_A: "", VAR_B: "value-b" }
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when second env var is empty", () => {
      const result = runBash(
        '_multi_creds_all_env_set VAR_A VAR_B',
        { VAR_A: "value-a", VAR_B: "" }
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when any env var is unset", () => {
      const result = runBash(
        'unset VAR_A; export VAR_B=val; _multi_creds_all_env_set VAR_A VAR_B'
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 0 for single env var that is set", () => {
      const result = runBash(
        '_multi_creds_all_env_set SINGLE_VAR',
        { SINGLE_VAR: "value" }
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 with three vars all set", () => {
      const result = runBash(
        '_multi_creds_all_env_set A B C',
        { A: "1", B: "2", C: "3" }
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 when last of three vars is empty", () => {
      const result = runBash(
        '_multi_creds_all_env_set A B C',
        { A: "1", B: "2", C: "" }
      );
      expect(result.exitCode).toBe(1);
    });
  });

  // ── _save_json_config ─────────────────────────────────────────────────────

  describe("_save_json_config", () => {
    it("should save single key-value pair as JSON", () => {
      const configFile = join(tempDir, "single.json");

      runBash(`_save_json_config "${configFile}" username myuser 2>&1`);

      expect(existsSync(configFile)).toBe(true);
      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.username).toBe("myuser");
    });

    it("should save multiple key-value pairs as JSON", () => {
      const configFile = join(tempDir, "multi.json");

      runBash(
        `_save_json_config "${configFile}" client_id my-id client_secret my-secret 2>&1`
      );

      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.client_id).toBe("my-id");
      expect(content.client_secret).toBe("my-secret");
    });

    it("should set file permissions to 600", () => {
      const configFile = join(tempDir, "perm.json");

      runBash(`_save_json_config "${configFile}" key value 2>&1`);

      const stats = statSync(configFile);
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe("600");
    });

    it("should create parent directories if missing", () => {
      const configFile = join(tempDir, "nested", "dir", "config.json");

      runBash(`_save_json_config "${configFile}" key value 2>&1`);

      expect(existsSync(configFile)).toBe(true);
    });

    it("should escape special characters in values", () => {
      const configFile = join(tempDir, "special.json");

      runBash(
        `_save_json_config "${configFile}" password 'p@ss"word\\with\\special' 2>&1`
      );

      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.password).toBe('p@ss"word\\with\\special');
    });

    it("should produce valid JSON with three key-value pairs", () => {
      const configFile = join(tempDir, "three.json");

      runBash(
        `_save_json_config "${configFile}" a one b two c three 2>&1`
      );

      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.a).toBe("one");
      expect(content.b).toBe("two");
      expect(content.c).toBe("three");
    });
  });

  // ── _load_json_config_fields ──────────────────────────────────────────────

  describe("_load_json_config_fields", () => {
    it("should load single field from config", () => {
      const configFile = join(tempDir, "fields.json");
      writeFileSync(configFile, JSON.stringify({ username: "admin" }));

      const result = runBash(
        `_load_json_config_fields "${configFile}" username`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("admin");
    });

    it("should load multiple fields from config", () => {
      const configFile = join(tempDir, "fields.json");
      writeFileSync(
        configFile,
        JSON.stringify({ username: "admin", password: "secret123" })
      );

      const result = runBash(
        `_load_json_config_fields "${configFile}" username password`
      );
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines[0]).toBe("admin");
      expect(lines[1]).toBe("secret123");
    });

    it("should return empty string for missing fields", () => {
      const configFile = join(tempDir, "fields.json");
      writeFileSync(configFile, JSON.stringify({ username: "admin" }));

      // Use raw stdout (not trimmed) to see the empty line
      const fullScript = `source "${COMMON_SH}"\n_load_json_config_fields "${configFile}" username missing_field`;
      const escapedScript = fullScript.replace(/'/g, "'\\''");
      let rawOutput: string;
      try {
        rawOutput = execSync(`bash -c '${escapedScript}'`, {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: "dumb" },
        });
      } catch (err: any) {
        rawOutput = err.stdout || "";
      }
      const lines = rawOutput.split("\n");
      expect(lines[0]).toBe("admin");
      // Missing field outputs an empty line (Python print(''))
      expect(lines[1]).toBe("");
    });

    it("should return 1 when config file does not exist", () => {
      const result = runBash(
        '_load_json_config_fields "/nonexistent.json" field1'
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 for corrupted JSON", () => {
      const configFile = join(tempDir, "corrupt.json");
      writeFileSync(configFile, "not-json{{{");

      const result = runBash(
        `_load_json_config_fields "${configFile}" field1`
      );
      expect(result.exitCode).toBe(1);
    });

    it("should handle fields with special characters in values", () => {
      const configFile = join(tempDir, "special.json");
      writeFileSync(
        configFile,
        JSON.stringify({ key: "value with spaces", path: "/usr/local/bin" })
      );

      const result = runBash(
        `_load_json_config_fields "${configFile}" key path`
      );
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines[0]).toBe("value with spaces");
      expect(lines[1]).toBe("/usr/local/bin");
    });
  });

  // ── _multi_creds_load_config ──────────────────────────────────────────────

  describe("_multi_creds_load_config", () => {
    it("should load two credentials from config file", () => {
      const configFile = join(tempDir, "multi-creds.json");
      writeFileSync(
        configFile,
        JSON.stringify({ user: "admin", pass: "secret" })
      );

      const result = runBash(
        `_multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS user pass && echo "user=$MY_USER pass=$MY_PASS"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("user=admin");
      expect(result.stdout).toContain("pass=secret");
    });

    it("should return 1 when config file is missing", () => {
      const result = runBash(
        '_multi_creds_load_config "/nonexistent.json" 2 MY_USER MY_PASS user pass'
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when a credential field is empty", () => {
      const configFile = join(tempDir, "partial.json");
      writeFileSync(
        configFile,
        JSON.stringify({ user: "admin", pass: "" })
      );

      const result = runBash(
        `_multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS user pass`
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return 1 when a credential field is missing from JSON", () => {
      const configFile = join(tempDir, "incomplete.json");
      writeFileSync(configFile, JSON.stringify({ user: "admin" }));

      const result = runBash(
        `_multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS user pass`
      );
      expect(result.exitCode).toBe(1);
    });

    it("should export env vars when all fields present", () => {
      const configFile = join(tempDir, "export-creds.json");
      writeFileSync(
        configFile,
        JSON.stringify({ client_id: "cid-123", client_secret: "csec-456" })
      );

      const result = runBash(
        `_multi_creds_load_config "${configFile}" 2 CID CSEC client_id client_secret && echo "CID=$CID CSEC=$CSEC"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CID=cid-123");
      expect(result.stdout).toContain("CSEC=csec-456");
    });
  });

  // ── _multi_creds_validate ─────────────────────────────────────────────────

  describe("_multi_creds_validate", () => {
    it("should return 0 when test_func is empty (no validation)", () => {
      const result = runBash(
        '_multi_creds_validate "" "TestProvider" VAR_A VAR_B'
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 when test function succeeds", () => {
      const result = runBash(
        'test_ok() { return 0; }; _multi_creds_validate test_ok "TestProvider" VAR_A 2>&1'
      );
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 when test function fails", () => {
      const result = runBash(
        'export V1=a V2=b; test_fail() { return 1; }; _multi_creds_validate test_fail "TestProvider" V1 V2 2>&1; echo "exit=$?"'
      );
      expect(result.stdout).toContain("exit=1");
    });

    it("should unset all env vars on validation failure", () => {
      const result = runBash(
        'export V1=a V2=b; test_fail() { return 1; }; _multi_creds_validate test_fail "TestProvider" V1 V2 2>/dev/null; echo "V1=${V1:-UNSET} V2=${V2:-UNSET}"'
      );
      expect(result.stdout).toContain("V1=UNSET");
      expect(result.stdout).toContain("V2=UNSET");
    });

    it("should show error message with provider name on failure", () => {
      const result = runBash(
        'export V1=a; test_fail() { return 1; }; _multi_creds_validate test_fail "Contabo" V1 2>&1'
      );
      expect(result.stdout).toContain("Invalid");
      expect(result.stdout).toContain("Contabo");
    });

    it("should log 'Testing credentials' before validation", () => {
      const result = runBash(
        'test_ok() { return 0; }; _multi_creds_validate test_ok "UpCloud" VAR_A 2>&1'
      );
      expect(result.stdout).toContain("Testing");
      expect(result.stdout).toContain("UpCloud");
    });
  });

  // ── Round-trip: _save_json_config + _load_json_config_fields ──────────────

  describe("round-trip: save + load", () => {
    it("should round-trip single key-value pair", () => {
      const configFile = join(tempDir, "roundtrip.json");

      runBash(`_save_json_config "${configFile}" api_key "sk-test-abc" 2>&1`);

      const result = runBash(
        `_load_json_config_fields "${configFile}" api_key`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("sk-test-abc");
    });

    it("should round-trip multiple key-value pairs", () => {
      const configFile = join(tempDir, "roundtrip-multi.json");

      runBash(
        `_save_json_config "${configFile}" username admin password "my secret" 2>&1`
      );

      const result = runBash(
        `_load_json_config_fields "${configFile}" username password`
      );
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines[0]).toBe("admin");
      expect(lines[1]).toBe("my secret");
    });

    it("should round-trip _save_token_to_config + _load_token_from_config", () => {
      const configFile = join(tempDir, "roundtrip-token.json");

      runBash(`_save_token_to_config "${configFile}" "round-trip-token" 2>&1`);

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_RT_TOKEN "TestProvider" 2>/dev/null && echo "$MY_RT_TOKEN"`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("round-trip-token");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("_save_json_config should handle token with newlines", () => {
      const configFile = join(tempDir, "newline.json");

      // Use printf to create a value with a literal newline
      runBash(
        `_save_json_config "${configFile}" key "line1" 2>&1`
      );

      expect(existsSync(configFile)).toBe(true);
      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.key).toBe("line1");
    });

    it("_load_token_from_config should handle empty JSON object", () => {
      const configFile = join(tempDir, "empty-obj.json");
      writeFileSync(configFile, "{}");

      const result = runBash(
        `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
      );
      expect(result.exitCode).toBe(1);
    });

    it("_load_json_config_fields should handle JSON with nested objects", () => {
      const configFile = join(tempDir, "nested.json");
      writeFileSync(
        configFile,
        JSON.stringify({ simple: "value", nested: { deep: "data" } })
      );

      const result = runBash(
        `_load_json_config_fields "${configFile}" simple`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("value");
    });

    it("_multi_creds_all_env_set should handle no arguments (vacuously true)", () => {
      const result = runBash("_multi_creds_all_env_set");
      expect(result.exitCode).toBe(0);
    });

    it("_save_json_config should handle empty value", () => {
      const configFile = join(tempDir, "empty-val.json");

      runBash(`_save_json_config "${configFile}" key "" 2>&1`);

      expect(existsSync(configFile)).toBe(true);
      const content = JSON.parse(readFileSync(configFile, "utf-8"));
      expect(content.key).toBe("");
    });
  });
});
