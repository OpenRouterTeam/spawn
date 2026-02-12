import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for credential management and instance polling helpers in shared/common.sh:
 *
 * Credential sub-helpers (used by ensure_api_token_with_provider):
 * - _load_token_from_env: Load API token from environment variable
 * - _load_token_from_config: Load API token from JSON config file
 * - _validate_token_with_provider: Validate token via test function
 * - _save_token_to_config: Save token to JSON config file with json_escape
 *
 * Multi-credential sub-helpers (used by ensure_multi_credentials):
 * - _multi_creds_all_env_set: Check if all env vars are set
 * - _multi_creds_load_config: Load multiple credentials from JSON config
 * - _multi_creds_validate: Validate credentials via test function
 *
 * Instance polling:
 * - generic_wait_for_instance: Poll cloud API for instance readiness
 *
 * These functions are security-critical (handle API tokens/credentials) and
 * reliability-critical (polling logic) but had zero test coverage despite
 * being used by every cloud provider.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

function runBash(script: string, env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const { spawnSync } = require("child_process");
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── _load_token_from_env ─────────────────────────────────────────────────────

describe("_load_token_from_env", () => {
  it("returns 0 when env var is set", () => {
    const r = runBash(
      `_load_token_from_env TEST_TOKEN_VAR "TestProvider"`,
      { TEST_TOKEN_VAR: "my-secret-token" }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("TestProvider");
  });

  it("returns 1 when env var is empty", () => {
    const r = runBash(
      `_load_token_from_env TEST_TOKEN_VAR "TestProvider"`,
      { TEST_TOKEN_VAR: "" }
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 1 when env var is unset", () => {
    const r = runBash(
      `unset NONEXISTENT_VAR 2>/dev/null; _load_token_from_env NONEXISTENT_VAR "TestProvider"`
    );
    expect(r.exitCode).toBe(1);
  });
});

// ── _load_token_from_config ──────────────────────────────────────────────────

describe("_load_token_from_config", () => {
  it("loads token from api_key field in config file", () => {
    const configFile = join(testDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "from-config-file" }));

    const r = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider" && echo "$MY_TOKEN"`
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("from-config-file");
  });

  it("loads token from token field in config file", () => {
    const configFile = join(testDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "token-value" }));

    const r = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider" && echo "$MY_TOKEN"`
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("token-value");
  });

  it("returns 1 when config file does not exist", () => {
    const r = runBash(
      `_load_token_from_config "${testDir}/nonexistent.json" MY_TOKEN "TestProvider"`
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 1 when config file has empty token", () => {
    const configFile = join(testDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "", token: "" }));

    const r = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 1 when config file is invalid JSON", () => {
    const configFile = join(testDir, "config.json");
    writeFileSync(configFile, "not valid json {{{");

    const r = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
    );
    expect(r.exitCode).toBe(1);
  });

  it("prefers api_key over token when both are present", () => {
    const configFile = join(testDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "api-key-val", token: "token-val" }));

    const r = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider" && echo "$MY_TOKEN"`
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("api-key-val");
  });
});

// ── _validate_token_with_provider ────────────────────────────────────────────

describe("_validate_token_with_provider", () => {
  it("returns 0 when test function succeeds", () => {
    const r = runBash(`
      test_ok() { return 0; }
      _validate_token_with_provider test_ok MY_TOKEN "TestProvider"
    `);
    expect(r.exitCode).toBe(0);
  });

  it("returns 1 when test function fails", () => {
    const r = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="some-token"
      _validate_token_with_provider test_fail MY_TOKEN "TestProvider"
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Authentication failed");
  });

  it("unsets env var on validation failure", () => {
    const r = runBash(`
      test_fail() { return 1; }
      export MY_TOKEN="some-token"
      _validate_token_with_provider test_fail MY_TOKEN "TestProvider"
      echo "TOKEN_AFTER=\${MY_TOKEN:-UNSET}"
    `);
    expect(r.stdout).toContain("TOKEN_AFTER=UNSET");
  });

  it("returns 0 when test function is empty (no validation)", () => {
    const r = runBash(`
      _validate_token_with_provider "" MY_TOKEN "TestProvider"
    `);
    expect(r.exitCode).toBe(0);
  });
});

// ── _save_token_to_config ────────────────────────────────────────────────────

describe("_save_token_to_config", () => {
  it("creates config file with token", () => {
    const configFile = join(testDir, "subdir", "config.json");

    const r = runBash(`_save_token_to_config "${configFile}" "my-secret-123"`);
    expect(r.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.api_key).toBe("my-secret-123");
    expect(content.token).toBe("my-secret-123");
  });

  it("creates parent directories if missing", () => {
    const configFile = join(testDir, "deep", "nested", "dir", "config.json");

    const r = runBash(`_save_token_to_config "${configFile}" "tok"`);
    expect(r.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);
  });

  it("escapes special characters in token via json_escape", () => {
    const configFile = join(testDir, "config.json");

    const r = runBash(`_save_token_to_config "${configFile}" 'tok"with\\"quotes'`);
    expect(r.exitCode).toBe(0);

    const raw = readFileSync(configFile, "utf-8");
    // Should be valid JSON
    const parsed = JSON.parse(raw);
    expect(parsed.api_key).toContain("tok");
  });

  it("sets restrictive permissions (600) on config file", () => {
    const configFile = join(testDir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "secret"`);
    const r = runBash(`stat -c '%a' "${configFile}"`);
    expect(r.stdout).toBe("600");
  });
});

// ── _multi_creds_all_env_set ─────────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("returns 0 when all env vars are set", () => {
    const r = runBash(
      `export VAR_A="a" VAR_B="b" VAR_C="c"
       _multi_creds_all_env_set VAR_A VAR_B VAR_C`
    );
    expect(r.exitCode).toBe(0);
  });

  it("returns 1 when one env var is missing", () => {
    const r = runBash(
      `export VAR_A="a" VAR_B=""
       _multi_creds_all_env_set VAR_A VAR_B`
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 1 when all env vars are empty", () => {
    const r = runBash(
      `unset VAR_X VAR_Y 2>/dev/null
       _multi_creds_all_env_set VAR_X VAR_Y`
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 0 with single env var set", () => {
    const r = runBash(
      `export SOLO_VAR="value"
       _multi_creds_all_env_set SOLO_VAR`
    );
    expect(r.exitCode).toBe(0);
  });
});

// ── _multi_creds_load_config ─────────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("loads multiple credentials from JSON config", () => {
    const configFile = join(testDir, "multi.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "my-client-id",
      client_secret: "my-secret",
    }));

    const r = runBash(`
      _multi_creds_load_config "${configFile}" 2 CRED_ID CRED_SECRET client_id client_secret
      echo "ID=$CRED_ID"
      echo "SECRET=$CRED_SECRET"
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ID=my-client-id");
    expect(r.stdout).toContain("SECRET=my-secret");
  });

  it("returns 1 when config file is missing", () => {
    const r = runBash(
      `_multi_creds_load_config "${testDir}/nonexistent.json" 1 MY_VAR some_key`
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 1 when a config field is empty", () => {
    const configFile = join(testDir, "partial.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "present",
      client_secret: "",
    }));

    const r = runBash(
      `_multi_creds_load_config "${configFile}" 2 CRED_ID CRED_SECRET client_id client_secret`
    );
    expect(r.exitCode).toBe(1);
  });

  it("returns 1 when a config field is missing entirely", () => {
    const configFile = join(testDir, "incomplete.json");
    writeFileSync(configFile, JSON.stringify({ client_id: "present" }));

    const r = runBash(
      `_multi_creds_load_config "${configFile}" 2 CRED_ID CRED_SECRET client_id client_secret`
    );
    expect(r.exitCode).toBe(1);
  });
});

// ── _multi_creds_validate ────────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("returns 0 when test function succeeds", () => {
    const r = runBash(`
      test_ok() { return 0; }
      _multi_creds_validate test_ok "TestProvider" VAR_A VAR_B
    `);
    expect(r.exitCode).toBe(0);
  });

  it("returns 1 and unsets vars when test function fails", () => {
    // Use set +e to prevent the script from exiting on the validation failure,
    // so we can inspect the env vars and exit code afterward.
    const r = runBash(`
      set +e
      test_fail() { return 1; }
      export VAR_A="a" VAR_B="b"
      _multi_creds_validate test_fail "TestProvider" VAR_A VAR_B
      RC=$?
      echo "A=\${VAR_A:-UNSET} B=\${VAR_B:-UNSET} RC=$RC"
    `);
    expect(r.stdout).toContain("A=UNSET");
    expect(r.stdout).toContain("B=UNSET");
    expect(r.stdout).toContain("RC=1");
    expect(r.stderr).toContain("Invalid TestProvider credentials");
  });

  it("returns 0 when test function is empty (no validation)", () => {
    const r = runBash(`
      _multi_creds_validate "" "TestProvider" VAR_A
    `);
    expect(r.exitCode).toBe(0);
  });
});

// ── generic_wait_for_instance ────────────────────────────────────────────────

describe("generic_wait_for_instance", () => {
  it("succeeds when API returns target status and IP on first attempt", () => {
    const r = runBash(`
      mock_api() {
        echo '{"instance": {"status": "active", "main_ip": "1.2.3.4"}}'
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/123" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_SERVER_IP "Test instance" 3
      echo "IP=$TEST_SERVER_IP"
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("IP=1.2.3.4");
  });

  it("polls until target status is reached", () => {
    // Use a file-based counter because generic_wait_for_instance calls the
    // API function inside a command substitution (subshell), so shell variables
    // are lost between calls.
    const counterFile = join(testDir, "poll-counter");
    writeFileSync(counterFile, "0");

    const r = runBash(`
      COUNTER_FILE="${counterFile}"
      mock_api() {
        local count; count=$(cat "$COUNTER_FILE")
        count=$((count + 1))
        echo "$count" > "$COUNTER_FILE"
        if [[ "$count" -lt 3 ]]; then
          echo '{"instance": {"status": "pending", "main_ip": ""}}'
        else
          echo '{"instance": {"status": "active", "main_ip": "10.0.0.1"}}'
        fi
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/x" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 5
      echo "RESULT_IP=$TEST_IP"
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("RESULT_IP=10.0.0.1");
  });

  it("fails after max_attempts exceeded", () => {
    const r = runBash(`
      mock_api() {
        echo '{"instance": {"status": "pending", "main_ip": ""}}'
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/x" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 2
    `);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("did not become active after 2 attempts");
  });

  it("handles API errors gracefully", () => {
    const r = runBash(`
      mock_api() {
        echo 'not json at all'
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/x" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 2
    `);
    expect(r.exitCode).toBe(1);
    // Should fail gracefully with "unknown" status, not crash
  });

  it("handles status reached but IP empty", () => {
    // When status matches but IP is empty, it should keep polling
    const counterFile = join(testDir, "ip-counter");
    writeFileSync(counterFile, "0");

    const r = runBash(`
      COUNTER_FILE="${counterFile}"
      mock_api() {
        local count; count=$(cat "$COUNTER_FILE")
        count=$((count + 1))
        echo "$count" > "$COUNTER_FILE"
        if [[ "$count" -lt 2 ]]; then
          echo '{"instance": {"status": "active", "main_ip": ""}}'
        else
          echo '{"instance": {"status": "active", "main_ip": "5.6.7.8"}}'
        fi
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/instances/x" "active" \
        "d['instance']['status']" "d['instance']['main_ip']" \
        TEST_IP "Instance" 5
      echo "GOT_IP=$TEST_IP"
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("GOT_IP=5.6.7.8");
  });

  it("defaults to 60 max_attempts when not specified", () => {
    // Just verify it parses correctly -- we won't actually wait 60 iterations
    // Instead, succeed on attempt 1
    const r = runBash(`
      mock_api() {
        echo '{"server": {"state": "running", "ip": "9.8.7.6"}}'
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/servers/1" "running" \
        "d['server']['state']" "d['server']['ip']" \
        SERVER_IP "Server"
      echo "IP=$SERVER_IP"
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("IP=9.8.7.6");
  });

  it("uses custom Python expressions for nested JSON", () => {
    const r = runBash(`
      mock_api() {
        echo '{"data": {"server": {"status": "ok"}, "network": {"ipv4": "192.168.1.1"}}}'
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/data" "ok" \
        "d['data']['server']['status']" "d['data']['network']['ipv4']" \
        MY_IP "Custom server" 3
      echo "CUSTOM_IP=$MY_IP"
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("CUSTOM_IP=192.168.1.1");
  });

  it("logs progress during polling", () => {
    const counterFile = join(testDir, "log-counter");
    writeFileSync(counterFile, "0");

    const r = runBash(`
      COUNTER_FILE="${counterFile}"
      mock_api() {
        local count; count=$(cat "$COUNTER_FILE")
        count=$((count + 1))
        echo "$count" > "$COUNTER_FILE"
        if [[ "$count" -lt 2 ]]; then
          echo '{"s": "building", "ip": ""}'
        else
          echo '{"s": "active", "ip": "1.1.1.1"}'
        fi
      }
      export INSTANCE_STATUS_POLL_DELAY=0
      generic_wait_for_instance mock_api "/x" "active" \
        "d['s']" "d['ip']" \
        IP "VM" 3
    `);
    expect(r.exitCode).toBe(0);
    // Check that status updates were logged
    expect(r.stderr).toContain("building");
  });
});

// ── ensure_api_token_with_provider (env path) ────────────────────────────────

describe("ensure_api_token_with_provider", () => {
  it("uses env var when set, without prompting", () => {
    const r = runBash(
      `ensure_api_token_with_provider "Test" MY_API_KEY "${testDir}/config.json" "https://example.com" ""
       echo "KEY=$MY_API_KEY"`,
      { MY_API_KEY: "env-token-value" }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("KEY=env-token-value");
  });

  it("uses config file when env var is not set", () => {
    const configFile = join(testDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "saved-token" }));

    const r = runBash(
      `unset MY_API_KEY 2>/dev/null
       ensure_api_token_with_provider "Test" MY_API_KEY "${configFile}" "https://example.com" ""
       echo "KEY=$MY_API_KEY"`
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("KEY=saved-token");
  });

  it("validates token with test function on env path", () => {
    const r = runBash(
      `test_valid() { return 0; }
       ensure_api_token_with_provider "Test" MY_KEY "${testDir}/config.json" "https://example.com" test_valid
       echo "KEY=$MY_KEY"`,
      { MY_KEY: "good-token" }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("KEY=good-token");
  });
});

// ── ensure_multi_credentials (env path) ──────────────────────────────────────

describe("ensure_multi_credentials", () => {
  it("uses env vars when all are set", () => {
    const r = runBash(
      `ensure_multi_credentials "TestProvider" "${testDir}/config.json" "https://example.com" "" \
         "CRED_USER:username:Username" "CRED_PASS:password:Password"
       echo "USER=$CRED_USER PASS=$CRED_PASS"`,
      { CRED_USER: "admin", CRED_PASS: "secret" }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("USER=admin");
    expect(r.stdout).toContain("PASS=secret");
  });

  it("falls through to config when env vars not set", () => {
    const configFile = join(testDir, "multi-config.json");
    writeFileSync(configFile, JSON.stringify({ username: "file-user", password: "file-pass" }));

    const r = runBash(
      `unset CRED_USER CRED_PASS 2>/dev/null
       ensure_multi_credentials "TestProvider" "${configFile}" "https://example.com" "" \
         "CRED_USER:username:Username" "CRED_PASS:password:Password"
       echo "USER=$CRED_USER PASS=$CRED_PASS"`
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("USER=file-user");
    expect(r.stdout).toContain("PASS=file-pass");
  });

  it("parses colon-delimited credential specs correctly", () => {
    const r = runBash(
      `ensure_multi_credentials "Test" "${testDir}/c.json" "https://x.com" "" \
         "VAR_A:key_a:Label A" "VAR_B:key_b:Label B" "VAR_C:key_c:Label C"
       echo "A=$VAR_A B=$VAR_B C=$VAR_C"`,
      { VAR_A: "a", VAR_B: "b", VAR_C: "c" }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("A=a");
    expect(r.stdout).toContain("B=b");
    expect(r.stdout).toContain("C=c");
  });

  it("validates with test function when provided", () => {
    const r = runBash(
      `test_creds() { return 0; }
       ensure_multi_credentials "Test" "${testDir}/c.json" "https://x.com" test_creds \
         "MY_ID:id:ID" "MY_SEC:secret:Secret"`,
      { MY_ID: "id-val", MY_SEC: "sec-val" }
    );
    expect(r.exitCode).toBe(0);
  });
});
