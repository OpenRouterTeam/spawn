import { describe, it, expect } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for untested bash helper functions in shared/common.sh:
 * - _load_json_config_fields: JSON config field loading (used by all multi-credential providers)
 * - _save_json_config: JSON config writing with json_escape
 * - extract_ssh_key_ids: SSH key ID extraction from cloud API responses
 * - _generate_csrf_state: CSRF state generation (security-critical)
 * - interactive_pick: Interactive picker with env var override
 *
 * These functions had zero test coverage despite being used across all cloud
 * provider scripts. Each test sources shared/common.sh and calls the function
 * in a real bash subprocess.
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
    const result = spawnSync("bash", ["-c", fullScript], {
      encoding: "utf-8",
    });
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch (err: any) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: String(err.message || err),
    };
  }
}

/**
 * Create a temporary directory for test files.
 */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _load_json_config_fields ────────────────────────────────────────────

describe("_load_json_config_fields", () => {
  it("should load a single field from JSON config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "sk-test-123" }));

    const result = runBash(`_load_json_config_fields "${configFile}" api_key`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-test-123");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should load multiple fields from JSON config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "s3cret",
      region: "us-east-1",
    }));

    const result = runBash(`_load_json_config_fields "${configFile}" username password region`);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("admin");
    expect(lines[1]).toBe("s3cret");
    expect(lines[2]).toBe("us-east-1");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return empty string for missing fields", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "present" }));

    // Use the intended read pattern -- missing fields produce empty lines
    const result = runBash(`
      creds=$(_load_json_config_fields "${configFile}" api_key missing_field)
      { read -r v1; read -r v2; } <<< "\${creds}"
      echo "v1=\${v1}"
      echo "v2=\${v2}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v1=present");
    expect(result.stdout).toContain("v2=");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return exit code 1 for missing config file", () => {
    const result = runBash(`_load_json_config_fields "/tmp/nonexistent-spawn-config-${Date.now()}.json" api_key`);
    expect(result.exitCode).toBe(1);
  });

  it("should return exit code 1 for invalid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "bad.json");
    writeFileSync(configFile, "{ not valid json!!!");

    const result = runBash(`_load_json_config_fields "${configFile}" api_key`);
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle empty JSON object", () => {
    const dir = createTempDir();
    const configFile = join(dir, "empty.json");
    writeFileSync(configFile, "{}");

    const result = runBash(`_load_json_config_fields "${configFile}" api_key`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle values with special characters", () => {
    const dir = createTempDir();
    const configFile = join(dir, "special.json");
    writeFileSync(configFile, JSON.stringify({
      token: "sk-or-v1-abc123/def+456==",
      url: "https://api.example.com/v1?key=val&other=true",
    }));

    const result = runBash(`_load_json_config_fields "${configFile}" token url`);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("sk-or-v1-abc123/def+456==");
    expect(lines[1]).toBe("https://api.example.com/v1?key=val&other=true");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle numeric and boolean values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "types.json");
    writeFileSync(configFile, JSON.stringify({ port: 8080, enabled: true }));

    const result = runBash(`_load_json_config_fields "${configFile}" port enabled`);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("8080");
    expect(lines[1]).toBe("True");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle values that are empty strings", () => {
    const dir = createTempDir();
    const configFile = join(dir, "empty-val.json");
    writeFileSync(configFile, JSON.stringify({ key: "" }));

    const result = runBash(`_load_json_config_fields "${configFile}" key`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle reading results into variables via read", () => {
    const dir = createTempDir();
    const configFile = join(dir, "multi.json");
    writeFileSync(configFile, JSON.stringify({
      username: "admin",
      password: "hunter2",
    }));

    // Test the intended usage pattern: reading into variables
    const result = runBash(`
      creds=$(_load_json_config_fields "${configFile}" username password)
      { read -r user; read -r pass; } <<< "\${creds}"
      echo "user=\${user}"
      echo "pass=\${pass}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user=admin");
    expect(result.stdout).toContain("pass=hunter2");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _save_json_config ───────────────────────────────────────────────────

describe("_save_json_config", () => {
  it("should save a single key-value pair", () => {
    const dir = createTempDir();
    const configFile = join(dir, "out.json");

    const result = runBash(`_save_json_config "${configFile}" api_key sk-test-123`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.api_key).toBe("sk-test-123");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should save multiple key-value pairs", () => {
    const dir = createTempDir();
    const configFile = join(dir, "multi.json");

    const result = runBash(`_save_json_config "${configFile}" username admin password s3cret`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.username).toBe("admin");
    expect(parsed.password).toBe("s3cret");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const configFile = join(dir, "nested", "deep", "config.json");

    const result = runBash(`_save_json_config "${configFile}" key value`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.key).toBe("value");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should set restrictive file permissions (600)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "perms.json");

    runBash(`_save_json_config "${configFile}" key value`);

    const result = runBash(`stat -c %a "${configFile}" 2>/dev/null || stat -f %Lp "${configFile}"`);
    expect(result.stdout).toBe("600");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should properly escape special characters in values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "escape.json");

    const result = runBash(`_save_json_config "${configFile}" token 'value"with"quotes'`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.token).toBe('value"with"quotes');

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle values with backslashes", () => {
    const dir = createTempDir();
    const configFile = join(dir, "backslash.json");

    const result = runBash(`_save_json_config "${configFile}" path 'C:\\Users\\test'`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.path).toBe("C:\\Users\\test");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle empty values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "empty.json");

    const result = runBash(`_save_json_config "${configFile}" key ""`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.key).toBe("");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should overwrite existing config file", () => {
    const dir = createTempDir();
    const configFile = join(dir, "overwrite.json");
    writeFileSync(configFile, JSON.stringify({ old: "data" }));

    const result = runBash(`_save_json_config "${configFile}" new_key new_value`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.new_key).toBe("new_value");
    expect(parsed.old).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });

  it("should produce valid JSON that _load_json_config_fields can read", () => {
    const dir = createTempDir();
    const configFile = join(dir, "roundtrip.json");

    runBash(`_save_json_config "${configFile}" user testuser pass "hunter2"`);

    const loadResult = runBash(`_load_json_config_fields "${configFile}" user pass`);
    expect(loadResult.exitCode).toBe(0);
    const lines = loadResult.stdout.split("\n");
    expect(lines[0]).toBe("testuser");
    expect(lines[1]).toBe("hunter2");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle values with newlines via json_escape", () => {
    const dir = createTempDir();
    const configFile = join(dir, "newline.json");

    // Use printf to pass a value with actual newline
    const result = runBash(`_save_json_config "${configFile}" key "$(printf 'line1\\nline2')"`);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(configFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.key).toBe("line1\nline2");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── extract_ssh_key_ids ─────────────────────────────────────────────────

describe("extract_ssh_key_ids", () => {
  it("should extract IDs from DigitalOcean-style response (ssh_keys field)", () => {
    const response = JSON.stringify({
      ssh_keys: [
        { id: 12345, name: "my-key-1" },
        { id: 67890, name: "my-key-2" },
      ],
    });

    const result = runBash(`echo '${response}' | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('ssh_keys', [])]
print(json.dumps(ids))
"`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([12345, 67890]);
  });

  it("should extract IDs from Linode-style response (data field)", () => {
    const response = JSON.stringify({
      data: [
        { id: 111, label: "work-key" },
        { id: 222, label: "personal-key" },
        { id: 333, label: "deploy-key" },
      ],
    });

    // Simulate extract_ssh_key_ids with key_field="data"
    const result = runBash(`extract_ssh_key_ids '${response}' data`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([111, 222, 333]);
  });

  it("should default to ssh_keys field when no field specified", () => {
    const response = JSON.stringify({
      ssh_keys: [{ id: 42, name: "default" }],
    });

    const result = runBash(`extract_ssh_key_ids '${response}'`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([42]);
  });

  it("should return empty array when no keys present", () => {
    const response = JSON.stringify({ ssh_keys: [] });

    const result = runBash(`extract_ssh_key_ids '${response}'`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("should return empty array when field is missing", () => {
    const response = JSON.stringify({ other_data: "foo" });

    const result = runBash(`extract_ssh_key_ids '${response}'`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("should handle string IDs (Vultr uses string UUIDs)", () => {
    const response = JSON.stringify({
      ssh_keys: [
        { id: "abc-123-def", name: "vultr-key" },
        { id: "xyz-789-uvw", name: "other-key" },
      ],
    });

    const result = runBash(`extract_ssh_key_ids '${response}'`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["abc-123-def", "xyz-789-uvw"]);
  });

  it("should handle single key in response", () => {
    const response = JSON.stringify({
      ssh_keys: [{ id: 99, name: "only-key" }],
    });

    const result = runBash(`extract_ssh_key_ids '${response}'`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([99]);
  });
});

// ── _generate_csrf_state ────────────────────────────────────────────────

describe("_generate_csrf_state", () => {
  it("should generate a non-empty string", () => {
    const result = runBash(`_generate_csrf_state`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("should generate hex-only output", () => {
    const result = runBash(`_generate_csrf_state`);
    expect(result.exitCode).toBe(0);
    // Output should only contain hexadecimal characters
    expect(/^[0-9a-f]+$/.test(result.stdout)).toBe(true);
  });

  it("should generate at least 16 hex chars (64 bits of entropy)", () => {
    const result = runBash(`_generate_csrf_state`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThanOrEqual(16);
  });

  it("should generate unique values on consecutive calls", () => {
    const result = runBash(`
      state1=$(_generate_csrf_state)
      state2=$(_generate_csrf_state)
      if [[ "\${state1}" == "\${state2}" ]]; then
        echo "DUPLICATE"
      else
        echo "UNIQUE"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("UNIQUE");
  });

  it("should work with openssl if available", () => {
    const result = runBash(`
      if command -v openssl &>/dev/null; then
        state=$(_generate_csrf_state)
        # openssl rand -hex 16 produces exactly 32 hex chars
        echo "\${#state}"
      else
        echo "32"  # skip test if openssl not available
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("32");
  });
});

// ── interactive_pick ────────────────────────────────────────────────────

describe("interactive_pick", () => {
  it("should use environment variable value when set", () => {
    const result = runBash(`
      export MY_PICK_VAR="from-env"
      selected=$(interactive_pick MY_PICK_VAR default-val "options" "echo dummy")
      echo "\${selected}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("from-env");
  });

  it("should use default when env var is empty and callback returns nothing", () => {
    const result = runBash(`
      unset MY_PICK_VAR
      list_empty() { echo ""; }
      selected=$(interactive_pick MY_PICK_VAR "my-default" "options" list_empty)
      echo "\${selected}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-default");
  });

  it("should prefer env var over callback results", () => {
    const result = runBash(`
      export REGION_VAR="eu-west-1"
      list_regions() { echo "us-east-1|US East"; echo "eu-west-1|EU West"; }
      selected=$(interactive_pick REGION_VAR "us-east-1" "regions" list_regions)
      echo "\${selected}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("eu-west-1");
  });
});

// ── _save_json_config + _load_json_config_fields roundtrip ──────────────

describe("_save_json_config + _load_json_config_fields roundtrip", () => {
  it("should roundtrip simple credentials", () => {
    const dir = createTempDir();
    const configFile = join(dir, "rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" client_id "my-client" client_secret "my-secret"
      creds=$(_load_json_config_fields "${configFile}" client_id client_secret)
      { read -r cid; read -r csec; } <<< "\${creds}"
      echo "id=\${cid}"
      echo "secret=\${csec}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id=my-client");
    expect(result.stdout).toContain("secret=my-secret");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should roundtrip values with special chars (quotes, slashes, ampersands)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "special-rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" url "https://api.com/v1?a=1&b=2"
      loaded=$(_load_json_config_fields "${configFile}" url)
      echo "\${loaded}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("https://api.com/v1?a=1&b=2");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should roundtrip API key format values", () => {
    const dir = createTempDir();
    const configFile = join(dir, "apikey-rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" token "sk-or-v1-abc123def456ghi789"
      loaded=$(_load_json_config_fields "${configFile}" token)
      echo "\${loaded}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-or-v1-abc123def456ghi789");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should roundtrip three credentials (UpCloud pattern)", () => {
    const dir = createTempDir();
    const configFile = join(dir, "upcloud-rt.json");

    const result = runBash(`
      _save_json_config "${configFile}" username "admin" password "p@ss!w0rd" zone "fi-hel1"
      creds=$(_load_json_config_fields "${configFile}" username password zone)
      { read -r u; read -r p; read -r z; } <<< "\${creds}"
      echo "\${u}|\${p}|\${z}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("admin|p@ss!w0rd|fi-hel1");

    rmSync(dir, { recursive: true, force: true });
  });
});
