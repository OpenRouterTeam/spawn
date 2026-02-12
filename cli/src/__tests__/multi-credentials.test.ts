import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for the multi-credential system in shared/common.sh:
 *
 * - _multi_creds_all_env_set: checks if all listed env vars are set and non-empty
 * - _multi_creds_load_config: loads credentials from JSON config into env vars
 * - _multi_creds_validate: runs a test function to validate credentials, unsets on failure
 * - ensure_multi_credentials: full pipeline (env -> config -> prompt -> validate -> save)
 *
 * These functions are used by 8+ providers (UpCloud, Contabo, OVH, Kamatera, IONOS,
 * Netcup, RamNode) and had zero test coverage despite being security-critical
 * (they handle API credentials).
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;
let configFile: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-multi-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  configFile = join(testDir, "test-config.json");
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(script: string, env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const envVars = {
    ...process.env,
    ...env,
    // Ensure no interactive prompts
    TERM: "dumb",
  };
  // Use a wrapper that captures stderr to a temp file so we can read it on success too
  const stderrFile = join(testDir, `stderr-${Math.random().toString(36).slice(2)}`);
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}' 2>"${stderrFile}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
        env: envVars,
      },
    );
    const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, "utf-8").trim() : "";
    return { exitCode: 0, stdout: stdout.trim(), stderr };
  } catch (err: any) {
    const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, "utf-8").trim() : (err.stderr || "").trim();
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

// ── _multi_creds_all_env_set ──────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("returns 0 when all env vars are set", () => {
    const result = runBash(
      `_multi_creds_all_env_set "HOME" "PATH"`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 when any env var is unset", () => {
    const result = runBash(
      `unset SPAWN_TEST_MISSING_VAR_XYZ 2>/dev/null; _multi_creds_all_env_set "HOME" "SPAWN_TEST_MISSING_VAR_XYZ"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("returns 1 when env var is empty string", () => {
    const result = runBash(
      `export SPAWN_EMPTY_VAR=""; _multi_creds_all_env_set "SPAWN_EMPTY_VAR"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("returns 0 for single set variable", () => {
    const result = runBash(
      `export SPAWN_TEST_SET="value"; _multi_creds_all_env_set "SPAWN_TEST_SET"`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 when first var is unset but second is set", () => {
    const result = runBash(
      `unset SPAWN_UNSET_A 2>/dev/null; export SPAWN_SET_B="ok"; _multi_creds_all_env_set "SPAWN_UNSET_A" "SPAWN_SET_B"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("returns 1 when second var is unset but first is set", () => {
    const result = runBash(
      `export SPAWN_SET_A="ok"; unset SPAWN_UNSET_B 2>/dev/null; _multi_creds_all_env_set "SPAWN_SET_A" "SPAWN_UNSET_B"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("returns 0 when three vars are all set", () => {
    const result = runBash(
      `export A1="x" A2="y" A3="z"; _multi_creds_all_env_set "A1" "A2" "A3"`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 when one of three vars is empty", () => {
    const result = runBash(
      `export A1="x" A2="" A3="z"; _multi_creds_all_env_set "A1" "A2" "A3"`,
    );
    expect(result.exitCode).toBe(1);
  });
});

// ── _multi_creds_load_config ──────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("loads all fields from a valid JSON config", () => {
    writeFileSync(configFile, JSON.stringify({
      client_id: "my-id-123",
      client_secret: "my-secret-456",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 MC_ID MC_SECRET client_id client_secret && echo "$MC_ID|$MC_SECRET"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-id-123|my-secret-456");
  });

  it("returns 1 when config file does not exist", () => {
    const result = runBash(
      `_multi_creds_load_config "/nonexistent/config.json" 1 MC_VAR some_key`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("returns 1 when a field is missing from the config", () => {
    writeFileSync(configFile, JSON.stringify({
      client_id: "my-id",
      // client_secret missing
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 MC_ID MC_SECRET client_id client_secret`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("returns 1 when a field value is empty string", () => {
    writeFileSync(configFile, JSON.stringify({
      username: "user",
      password: "",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 MC_USER MC_PASS username password`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("handles single credential correctly", () => {
    writeFileSync(configFile, JSON.stringify({
      api_key: "sk-test-key",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 1 MC_KEY api_key && echo "$MC_KEY"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-test-key");
  });

  it("loads three credentials correctly", () => {
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "pass123",
      endpoint: "https://api.example.com",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 3 MC_USER MC_PASS MC_URL username password endpoint && echo "$MC_USER|$MC_PASS|$MC_URL"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("admin|pass123|https://api.example.com");
  });

  it("exports env vars so they are available in subshells", () => {
    writeFileSync(configFile, JSON.stringify({
      token: "abc123",
    }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 1 MC_TOKEN token && bash -c 'echo $MC_TOKEN'`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abc123");
  });

  it("returns 1 for malformed JSON config", () => {
    writeFileSync(configFile, "not valid json {{{");

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 1 MC_KEY api_key`,
    );
    expect(result.exitCode).toBe(1);
  });
});

// ── _multi_creds_validate ──────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("returns 0 when test function succeeds", () => {
    const result = runBash(
      `test_ok() { return 0; }; _multi_creds_validate "test_ok" "TestProvider" "VAR1" "VAR2"`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("returns 1 and unsets vars when test function fails", () => {
    // Use || true to prevent set -e from killing the script
    const script = [
      'export SPAWN_V1="a" SPAWN_V2="b"',
      'test_fail() { return 1; }',
      '_multi_creds_validate "test_fail" "TestProvider" "SPAWN_V1" "SPAWN_V2" || RC=$?',
      'echo "RC=${RC}"',
      'echo "V1=${SPAWN_V1:-UNSET} V2=${SPAWN_V2:-UNSET}"',
    ].join("\n");
    const result = runBash(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("RC=1");
    // The vars should be unset after validation failure
    expect(result.stdout).toContain("V1=UNSET");
    expect(result.stdout).toContain("V2=UNSET");
    expect(result.stderr).toContain("Invalid TestProvider credentials");
  });

  it("returns 0 when test_func is empty string (no validation)", () => {
    const result = runBash(
      `_multi_creds_validate "" "TestProvider" "VAR1"`,
    );
    expect(result.exitCode).toBe(0);
  });

  it("preserves env vars when validation succeeds", () => {
    const result = runBash(
      `export SPAWN_KEEP="preserved"
test_ok() { return 0; }
_multi_creds_validate "test_ok" "MyProvider" "SPAWN_KEEP" && echo "$SPAWN_KEEP"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("preserved");
  });

  it("shows error messages on validation failure", () => {
    const result = runBash(
      `test_fail() { return 1; }
_multi_creds_validate "test_fail" "UpCloud" "UC_USER"`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid UpCloud credentials");
  });

  it("shows provider-specific error message", () => {
    const result = runBash(
      `test_fail() { return 1; }
_multi_creds_validate "test_fail" "Contabo" "CT_ID" "CT_SECRET"`,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Contabo");
  });
});

// ── ensure_multi_credentials (env var path) ────────────────────────────────

describe("ensure_multi_credentials - env var path", () => {
  it("returns 0 immediately when all env vars are already set", () => {
    const result = runBash(
      `export SPAWN_MC_ID="my-id" SPAWN_MC_SECRET="my-secret"
ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
  "SPAWN_MC_ID:client_id:Client ID" \
  "SPAWN_MC_SECRET:client_secret:Client Secret"`,
      { SPAWN_MC_ID: "my-id", SPAWN_MC_SECRET: "my-secret" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using TestCloud credentials from environment");
  });

  it("does not write config file when env vars are pre-set", () => {
    runBash(
      `export SPAWN_MC_ID="my-id" SPAWN_MC_SECRET="my-secret"
ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
  "SPAWN_MC_ID:client_id:Client ID" \
  "SPAWN_MC_SECRET:client_secret:Client Secret"`,
      { SPAWN_MC_ID: "my-id", SPAWN_MC_SECRET: "my-secret" },
    );
    // Should not create config file since env vars were sufficient
    expect(existsSync(configFile)).toBe(false);
  });
});

// ── ensure_multi_credentials (config file path) ──────────────────────────

describe("ensure_multi_credentials - config file path", () => {
  it("loads from config file when env vars are not set", () => {
    writeFileSync(configFile, JSON.stringify({
      client_id: "config-id",
      client_secret: "config-secret",
    }));

    const result = runBash(
      `unset SPAWN_MC_ID SPAWN_MC_SECRET 2>/dev/null
ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
  "SPAWN_MC_ID:client_id:Client ID" \
  "SPAWN_MC_SECRET:client_secret:Client Secret" && echo "$SPAWN_MC_ID|$SPAWN_MC_SECRET"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("config-id|config-secret");
    expect(result.stderr).toContain("Using TestCloud credentials from");
  });

  it("prefers env vars over config file", () => {
    writeFileSync(configFile, JSON.stringify({
      api_key: "config-key",
    }));

    const result = runBash(
      `export SPAWN_MC_KEY="env-key"
ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
  "SPAWN_MC_KEY:api_key:API Key" && echo "$SPAWN_MC_KEY"`,
      { SPAWN_MC_KEY: "env-key" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("env-key");
    expect(result.stderr).toContain("from environment");
  });
});

// ── ensure_multi_credentials (validation path) ──────────────────────────

describe("ensure_multi_credentials - validation", () => {
  it("validates credentials from config file with test function", () => {
    writeFileSync(configFile, JSON.stringify({
      api_key: "valid-key",
    }));

    const result = runBash(
      `test_creds() { return 0; }
unset SPAWN_MC_KEY 2>/dev/null
ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "test_creds" \
  "SPAWN_MC_KEY:api_key:API Key" && echo "OK"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });
});

// ── ensure_multi_credentials (spec parsing) ────────────────────────────────

describe("ensure_multi_credentials - credential spec parsing", () => {
  it("correctly parses colon-delimited specs (ENV:config_key:Label)", () => {
    // Verify the spec parsing by setting env vars and confirming success
    const result = runBash(
      `export UPC_USER="user1" UPC_PASS="pass1"
ensure_multi_credentials "UpCloud" "${configFile}" "https://upcloud.com" "" \
  "UPC_USER:username:Username" \
  "UPC_PASS:password:Password"`,
      { UPC_USER: "user1", UPC_PASS: "pass1" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("UpCloud");
  });

  it("handles three credential specs", () => {
    const result = runBash(
      `export S_A="a" S_B="b" S_C="c"
ensure_multi_credentials "MultiAuth" "${configFile}" "https://example.com" "" \
  "S_A:field_a:Field A" \
  "S_B:field_b:Field B" \
  "S_C:field_c:Field C"`,
      { S_A: "a", S_B: "b", S_C: "c" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using MultiAuth credentials from environment");
  });

  it("works with single credential spec", () => {
    const result = runBash(
      `export S_TOKEN="tok123"
ensure_multi_credentials "SimpleAuth" "${configFile}" "https://example.com" "" \
  "S_TOKEN:token:API Token"`,
      { S_TOKEN: "tok123" },
    );
    expect(result.exitCode).toBe(0);
  });
});

// ── ensure_multi_credentials (config save after prompt) ──────────────────

describe("ensure_multi_credentials - config save", () => {
  it("saves loaded config credentials back to file on first load", () => {
    writeFileSync(configFile, JSON.stringify({
      username: "saved-user",
      password: "saved-pass",
    }));

    const result = runBash(
      `unset SPAWN_MC_USER SPAWN_MC_PASS 2>/dev/null
ensure_multi_credentials "TestCloud" "${configFile}" "https://example.com" "" \
  "SPAWN_MC_USER:username:Username" \
  "SPAWN_MC_PASS:password:Password"`,
    );
    expect(result.exitCode).toBe(0);
    // Config file should still exist and be valid
    expect(existsSync(configFile)).toBe(true);
    const config = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(config.username).toBe("saved-user");
  });
});

// ── inject_env_vars_ssh ────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("calls upload and run functions with correct arguments", () => {
    // We stub the upload/run functions to capture their args
    const result = runBash(
      `mock_upload() { echo "UPLOAD: $1 -> $2 -> $3"; }
mock_run() { echo "RUN: $1 -> $2"; }
inject_env_vars_ssh "1.2.3.4" mock_upload mock_run "KEY1=val1" "KEY2=val2"`,
    );
    expect(result.exitCode).toBe(0);
    // Verify upload was called with server_ip, temp file, and /tmp/env_config
    expect(result.stdout).toContain("UPLOAD: 1.2.3.4");
    expect(result.stdout).toContain("/tmp/env_config");
    // Verify run was called with server_ip and the append command
    expect(result.stdout).toContain("RUN: 1.2.3.4");
    expect(result.stdout).toContain(".zshrc");
  });

  it("generates correct env config content via upload", () => {
    const result = runBash(
      `mock_upload() { cat "$2"; }
mock_run() { true; }
inject_env_vars_ssh "1.2.3.4" mock_upload mock_run "MY_KEY=my_value"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export MY_KEY='my_value'");
    expect(result.stdout).toContain("[spawn:env]");
  });

  it("handles multiple env vars", () => {
    const result = runBash(
      `mock_upload() { cat "$2"; }
mock_run() { true; }
inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "API_KEY=abc" "BASE_URL=https://example.com"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export API_KEY='abc'");
    expect(result.stdout).toContain("export BASE_URL='https://example.com'");
  });

  it("creates temp file with restricted permissions", () => {
    // Verify the temp file has 600 permissions (only readable by owner)
    const result = runBash(
      `mock_upload() { stat -c '%a' "$2" 2>/dev/null || stat -f '%Lp' "$2" 2>/dev/null; }
mock_run() { true; }
inject_env_vars_ssh "1.2.3.4" mock_upload mock_run "SECRET=value"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("600");
  });
});

// ── inject_env_vars_local ──────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("calls upload and run functions without server_ip", () => {
    const result = runBash(
      `mock_upload() { echo "UPLOAD: $1 -> $2"; }
mock_run() { echo "RUN: $1"; }
inject_env_vars_local mock_upload mock_run "KEY1=val1"`,
    );
    expect(result.exitCode).toBe(0);
    // For local, upload gets (temp_file, /tmp/env_config) -- no server_ip
    expect(result.stdout).toContain("UPLOAD:");
    expect(result.stdout).toContain("/tmp/env_config");
    // Run gets the append command -- no server_ip
    expect(result.stdout).toContain("RUN: cat /tmp/env_config >> ~/.zshrc");
  });

  it("generates correct env config content", () => {
    const result = runBash(
      `mock_upload() { cat "$1"; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "TOKEN=sk-or-v1-abc123"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export TOKEN='sk-or-v1-abc123'");
  });

  it("handles multiple env vars for local providers", () => {
    const result = runBash(
      `mock_upload() { cat "$1"; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "OPENROUTER_API_KEY=key1" "ANTHROPIC_BASE_URL=https://openrouter.ai/api"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export OPENROUTER_API_KEY='key1'");
    expect(result.stdout).toContain("export ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
  });

  it("creates temp file with restricted permissions", () => {
    const result = runBash(
      `mock_upload() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "SECRET=value"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("600");
  });
});

// ── upload_config_file ──────────────────────────────────────────────────────

describe("upload_config_file", () => {
  it("uploads content to a remote path via callback", () => {
    const result = runBash(
      `mock_upload() { echo "UPLOAD: $1 -> $2"; cat "$1"; }
mock_run() { echo "RUN: $1"; }
upload_config_file mock_upload mock_run '{"key": "value"}' "~/.config/app.json"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('{"key": "value"}');
    expect(result.stdout).toContain("RUN: mv");
    expect(result.stdout).toContain("app.json");
  });

  it("creates temp file with 600 permissions", () => {
    const result = runBash(
      `mock_upload() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
mock_run() { true; }
upload_config_file mock_upload mock_run "content" "/tmp/dest"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("600");
  });

  it("uses printf to write content (preserves special characters)", () => {
    const result = runBash(
      `mock_upload() { cat "$1"; }
mock_run() { true; }
upload_config_file mock_upload mock_run 'line1
line2
line3' "/tmp/dest"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(result.stdout).toContain("line3");
  });

  it("moves file to remote path via run callback", () => {
    const result = runBash(
      `mock_upload() { true; }
mock_run() { echo "$1"; }
upload_config_file mock_upload mock_run "data" "~/.config/test/settings.json"`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mv");
    expect(result.stdout).toContain("settings.json");
  });
});
