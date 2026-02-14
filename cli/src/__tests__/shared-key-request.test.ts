import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for shared/key-request.sh — credential loading and key server helpers.
 *
 * This file has zero existing test coverage. It provides:
 *   - get_cloud_env_vars: Extract env var names for a cloud from manifest.json
 *   - _parse_cloud_auths: Parse manifest for cloud auth specs (cloud_key|auth_string)
 *   - _try_load_env_var: Load a single env var from a JSON config file
 *   - _load_cloud_credentials: Load all env vars for one cloud provider
 *   - load_cloud_keys_from_config: Full credential loader from ~/.config/spawn/
 *   - request_missing_cloud_keys: Fire-and-forget POST to key server
 *   - invalidate_cloud_key: Delete a cloud's config file (with path traversal guard)
 *
 * Each test sources shared/key-request.sh in a real bash subprocess.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const KEY_REQUEST_SH = resolve(REPO_ROOT, "shared/key-request.sh");

// ── Test helpers ────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-keyreq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/** Create a minimal manifest.json for testing */
function createTestManifest(clouds: Record<string, { auth: string }>): string {
  const manifest: any = {
    agents: { claude: { name: "Claude", description: "test", url: "", install: "", launch: "", env: {} } },
    clouds: {} as any,
    matrix: {},
  };
  for (const [key, def] of Object.entries(clouds)) {
    manifest.clouds[key] = {
      name: key,
      description: "test",
      url: "",
      type: "vm",
      auth: def.auth,
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    };
  }
  const path = join(testDir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

/** Run a bash snippet that sources key-request.sh. */
function runBash(
  script: string,
  env?: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${KEY_REQUEST_SH}"\n${script}`;
  const mergedEnv = {
    ...process.env,
    HOME: testDir,
    REPO_ROOT: testDir,
    ...(env || {}),
  };
  try {
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? "").toString().trim(),
      stderr: (err.stderr ?? "").toString().trim(),
    };
  }
}

// ============================================================================
// get_cloud_env_vars
// ============================================================================

describe("get_cloud_env_vars", () => {
  it("should return single env var for simple auth", () => {
    const manifestPath = createTestManifest({ hetzner: { auth: "HCLOUD_TOKEN" } });
    const result = runBash(`get_cloud_env_vars "hetzner"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("HCLOUD_TOKEN");
  });

  it("should return multiple env vars for multi-auth clouds", () => {
    const manifestPath = createTestManifest({ upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD" } });
    const result = runBash(`get_cloud_env_vars "upcloud"`);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("UPCLOUD_USERNAME");
    expect(lines).toContain("UPCLOUD_PASSWORD");
  });

  it("should return empty output for CLI-based auth (login)", () => {
    const manifestPath = createTestManifest({ sprite: { auth: "sprite login" } });
    const result = runBash(`get_cloud_env_vars "sprite"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should return empty output for CLI-based auth (configure)", () => {
    const manifestPath = createTestManifest({ aws: { auth: "aws configure" } });
    const result = runBash(`get_cloud_env_vars "aws"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should return empty output for CLI-based auth (setup)", () => {
    const manifestPath = createTestManifest({ local: { auth: "local setup" } });
    const result = runBash(`get_cloud_env_vars "local"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should return empty for nonexistent cloud key", () => {
    createTestManifest({ hetzner: { auth: "HCLOUD_TOKEN" } });
    const result = runBash(`get_cloud_env_vars "nonexistent"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should handle cloud with empty auth field", () => {
    createTestManifest({ noauth: { auth: "" } });
    const result = runBash(`get_cloud_env_vars "noauth"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

// ============================================================================
// _parse_cloud_auths
// ============================================================================

describe("_parse_cloud_auths", () => {
  it("should output cloud_key|auth_string for API-token clouds", () => {
    const manifestPath = createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      vultr: { auth: "VULTR_API_KEY" },
    });
    const result = runBash(`_parse_cloud_auths "${manifestPath}"`);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("hetzner|HCLOUD_TOKEN");
    expect(lines).toContain("vultr|VULTR_API_KEY");
  });

  it("should skip CLI-based auth clouds", () => {
    const manifestPath = createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      sprite: { auth: "sprite login" },
      aws: { auth: "aws configure" },
    });
    const result = runBash(`_parse_cloud_auths "${manifestPath}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hetzner|HCLOUD_TOKEN");
    expect(result.stdout).not.toContain("sprite");
    expect(result.stdout).not.toContain("aws");
  });

  it("should skip clouds with empty auth", () => {
    const manifestPath = createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      noauth: { auth: "" },
    });
    const result = runBash(`_parse_cloud_auths "${manifestPath}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hetzner|HCLOUD_TOKEN");
    expect(result.stdout).not.toContain("noauth");
  });

  it("should handle multi-credential auth strings", () => {
    const manifestPath = createTestManifest({
      upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD" },
    });
    const result = runBash(`_parse_cloud_auths "${manifestPath}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("upcloud|UPCLOUD_USERNAME + UPCLOUD_PASSWORD");
  });

  it("should return empty output for empty manifest clouds", () => {
    const manifestPath = createTestManifest({});
    const result = runBash(`_parse_cloud_auths "${manifestPath}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should return empty for missing manifest file", () => {
    const result = runBash(`_parse_cloud_auths "/nonexistent/manifest.json"`);
    // python3 will fail silently due to 2>/dev/null
    expect(result.stdout).toBe("");
  });
});

// ============================================================================
// _try_load_env_var
// ============================================================================

describe("_try_load_env_var", () => {
  it("should return 0 when env var is already set", () => {
    const result = runBash(
      `export MY_TOKEN="already-set"
       _try_load_env_var "MY_TOKEN" "/nonexistent/config.json"
       echo "exit=$?"`,
      { MY_TOKEN: "already-set" },
    );
    expect(result.stdout).toContain("exit=0");
  });

  it("should load value from config file when env var is not set", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), JSON.stringify({ MY_TOKEN: "from-config" }));

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"
       echo "val=\${MY_TOKEN}"`,
    );
    expect(result.stdout).toContain("val=from-config");
  });

  it("should return 1 when env var is not set and config file is missing", () => {
    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "/nonexistent/config.json"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is not set and config file has no matching key", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), JSON.stringify({ OTHER_KEY: "value" }));

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("should fall back to api_key field in config file", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), JSON.stringify({ api_key: "fallback-key" }));

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"
       echo "val=\${MY_TOKEN}"`,
    );
    expect(result.stdout).toContain("val=fallback-key");
  });

  it("should fall back to token field in config file", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), JSON.stringify({ token: "token-value" }));

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"
       echo "val=\${MY_TOKEN}"`,
    );
    expect(result.stdout).toContain("val=token-value");
  });

  it("should prefer exact var name over api_key fallback", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "test.json"),
      JSON.stringify({ MY_TOKEN: "exact-match", api_key: "fallback" }),
    );

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"
       echo "val=\${MY_TOKEN}"`,
    );
    expect(result.stdout).toContain("val=exact-match");
  });

  it("should export the loaded variable", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), JSON.stringify({ MY_TOKEN: "exported-val" }));

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"
       # Verify it's exported (available in subshell)
       bash -c 'echo "sub=\${MY_TOKEN}"'`,
    );
    expect(result.stdout).toContain("sub=exported-val");
  });

  it("should return 1 when config file contains empty value for the key", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), JSON.stringify({ MY_TOKEN: "" }));

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("should handle malformed JSON gracefully", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "test.json"), "not valid json{{{");

    const result = runBash(
      `unset MY_TOKEN 2>/dev/null
       _try_load_env_var "MY_TOKEN" "${configDir}/test.json"`,
    );
    expect(result.exitCode).toBe(1);
  });
});

// ============================================================================
// _load_cloud_credentials
// ============================================================================

describe("_load_cloud_credentials", () => {
  it("should load single-var credentials from config file", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "test-token" }));

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       _load_cloud_credentials "hetzner" "HCLOUD_TOKEN"
       echo "exit=$?"
       echo "val=\${HCLOUD_TOKEN}"`,
    );
    expect(result.stdout).toContain("exit=0");
    expect(result.stdout).toContain("val=test-token");
  });

  it("should load multi-var credentials from config file", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "upcloud.json"),
      JSON.stringify({ UPCLOUD_USERNAME: "user", UPCLOUD_PASSWORD: "pass" }),
    );

    const result = runBash(
      `unset UPCLOUD_USERNAME UPCLOUD_PASSWORD 2>/dev/null
       _load_cloud_credentials "upcloud" "UPCLOUD_USERNAME + UPCLOUD_PASSWORD"
       echo "exit=$?"
       echo "u=\${UPCLOUD_USERNAME}"
       echo "p=\${UPCLOUD_PASSWORD}"`,
    );
    expect(result.stdout).toContain("exit=0");
    expect(result.stdout).toContain("u=user");
    expect(result.stdout).toContain("p=pass");
  });

  it("should return 1 when config file is missing", () => {
    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       _load_cloud_credentials "hetzner" "HCLOUD_TOKEN"`,
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 when env vars are already set", () => {
    const result = runBash(
      `export HCLOUD_TOKEN="already-set"
       _load_cloud_credentials "hetzner" "HCLOUD_TOKEN"`,
      { HCLOUD_TOKEN: "already-set" },
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when only some multi-cred vars are available", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "upcloud.json"),
      JSON.stringify({ UPCLOUD_USERNAME: "user" }),
      // Note: UPCLOUD_PASSWORD is missing
    );

    const result = runBash(
      `unset UPCLOUD_USERNAME UPCLOUD_PASSWORD 2>/dev/null
       _load_cloud_credentials "upcloud" "UPCLOUD_USERNAME + UPCLOUD_PASSWORD"`,
    );
    expect(result.exitCode).toBe(1);
  });
});

// ============================================================================
// load_cloud_keys_from_config
// ============================================================================

describe("load_cloud_keys_from_config", () => {
  it("should log key preflight count", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
    });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "token123" }));

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       load_cloud_keys_from_config 2>&1`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Key preflight:");
    expect(result.stdout).toContain("1/1");
  });

  it("should set MISSING_KEY_PROVIDERS for clouds without keys", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      vultr: { auth: "VULTR_API_KEY" },
    });

    const result = runBash(
      `unset HCLOUD_TOKEN VULTR_API_KEY 2>/dev/null
       load_cloud_keys_from_config 2>/dev/null
       echo "missing=\${MISSING_KEY_PROVIDERS}"`,
    );
    expect(result.stdout).toContain("hetzner");
    expect(result.stdout).toContain("vultr");
  });

  it("should not include loaded clouds in MISSING_KEY_PROVIDERS", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      vultr: { auth: "VULTR_API_KEY" },
    });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "token123" }));

    const result = runBash(
      `unset HCLOUD_TOKEN VULTR_API_KEY 2>/dev/null
       load_cloud_keys_from_config 2>/dev/null
       echo "missing=\${MISSING_KEY_PROVIDERS}"`,
    );
    expect(result.stdout).not.toContain("hetzner");
    expect(result.stdout).toContain("vultr");
  });

  it("should skip CLI-based auth clouds", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      sprite: { auth: "sprite login" },
    });

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       load_cloud_keys_from_config 2>/dev/null
       echo "missing=\${MISSING_KEY_PROVIDERS}"`,
    );
    // sprite should not appear since it uses CLI-based auth
    expect(result.stdout).not.toContain("sprite");
    expect(result.stdout).toContain("hetzner");
  });

  it("should return 1 when manifest.json is missing", () => {
    // Don't create a manifest
    const result = runBash(`load_cloud_keys_from_config 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("manifest.json not found");
  });

  it("should export loaded env vars", () => {
    createTestManifest({ hetzner: { auth: "HCLOUD_TOKEN" } });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "loaded-token" }));

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       load_cloud_keys_from_config 2>/dev/null
       echo "token=\${HCLOUD_TOKEN}"`,
    );
    expect(result.stdout).toContain("token=loaded-token");
  });

  it("should handle empty MISSING_KEY_PROVIDERS when all keys are loaded", () => {
    createTestManifest({ hetzner: { auth: "HCLOUD_TOKEN" } });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "token123" }));

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       load_cloud_keys_from_config 2>/dev/null
       echo "missing=[\${MISSING_KEY_PROVIDERS}]"`,
    );
    expect(result.stdout).toContain("missing=[]");
  });

  it("should count correctly with multiple clouds", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      vultr: { auth: "VULTR_API_KEY" },
      linode: { auth: "LINODE_TOKEN" },
    });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "t1" }));
    writeFileSync(join(configDir, "vultr.json"), JSON.stringify({ VULTR_API_KEY: "t2" }));

    const result = runBash(
      `unset HCLOUD_TOKEN VULTR_API_KEY LINODE_TOKEN 2>/dev/null
       load_cloud_keys_from_config 2>&1`,
    );
    expect(result.stdout).toContain("2/3");
    expect(result.stdout).toContain("linode");
  });
});

// ============================================================================
// invalidate_cloud_key
// ============================================================================

describe("invalidate_cloud_key", () => {
  it("should delete the config file for a valid provider", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, "hetzner.json");
    writeFileSync(configFile, JSON.stringify({ HCLOUD_TOKEN: "secret" }));

    const result = runBash(`invalidate_cloud_key "hetzner" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(false);
    expect(result.stdout).toContain("Invalidated key config for hetzner");
  });

  it("should succeed silently when config file does not exist", () => {
    const result = runBash(`invalidate_cloud_key "hetzner" 2>&1`);
    expect(result.exitCode).toBe(0);
  });

  it("should reject path traversal attempts (..)", () => {
    const result = runBash(`invalidate_cloud_key "../etc/passwd" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should reject provider names starting with a hyphen", () => {
    const result = runBash(`invalidate_cloud_key "-badname" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should reject provider names with slashes", () => {
    const result = runBash(`invalidate_cloud_key "foo/bar" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should reject empty provider name", () => {
    const result = runBash(`invalidate_cloud_key "" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should reject provider names longer than 64 characters", () => {
    const longName = "a".repeat(65);
    const result = runBash(`invalidate_cloud_key "${longName}" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should accept valid provider names with dots, hyphens, underscores", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, "my-cloud_v2.json");
    writeFileSync(configFile, JSON.stringify({ TOKEN: "val" }));

    const result = runBash(`invalidate_cloud_key "my-cloud_v2" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(false);
  });

  it("should accept exactly 64-character provider names", () => {
    const name = "a".repeat(64);
    const result = runBash(`invalidate_cloud_key "${name}" 2>&1`);
    expect(result.exitCode).toBe(0);
  });

  it("should reject provider names with spaces", () => {
    const result = runBash(`invalidate_cloud_key "bad name" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should reject provider names with uppercase letters", () => {
    const result = runBash(`invalidate_cloud_key "BadName" 2>&1`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid provider name");
  });

  it("should not delete non-JSON files or directories", () => {
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    // Only hetzner.json should be targeted, not a directory
    const dirToPreserve = join(configDir, "hetzner");
    mkdirSync(dirToPreserve, { recursive: true });

    const result = runBash(`invalidate_cloud_key "hetzner" 2>&1`);
    expect(result.exitCode).toBe(0);
    // The function uses -f (regular file check), so directory should be preserved
    expect(existsSync(dirToPreserve)).toBe(true);
  });
});

// ============================================================================
// request_missing_cloud_keys
// ============================================================================

describe("request_missing_cloud_keys", () => {
  it("should skip silently when KEY_SERVER_URL is not set", () => {
    const result = runBash(
      `unset KEY_SERVER_URL 2>/dev/null
       MISSING_KEY_PROVIDERS="hetzner vultr"
       request_missing_cloud_keys 2>&1`,
      { KEY_SERVER_URL: "" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Requesting keys");
  });

  it("should warn when KEY_SERVER_SECRET is empty", () => {
    const result = runBash(
      `export KEY_SERVER_URL="http://localhost:9999"
       unset KEY_SERVER_SECRET 2>/dev/null
       MISSING_KEY_PROVIDERS="hetzner"
       request_missing_cloud_keys 2>&1`,
      { KEY_SERVER_URL: "http://localhost:9999", KEY_SERVER_SECRET: "" },
    );
    expect(result.stdout).toContain("KEY_SERVER_SECRET is empty");
  });

  it("should skip when MISSING_KEY_PROVIDERS is empty", () => {
    const result = runBash(
      `export KEY_SERVER_URL="http://localhost:9999"
       export KEY_SERVER_SECRET="secret123"
       MISSING_KEY_PROVIDERS=""
       request_missing_cloud_keys 2>&1`,
      { KEY_SERVER_URL: "http://localhost:9999", KEY_SERVER_SECRET: "secret123" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Requesting keys");
  });

  it("should log the request when all params are set", () => {
    // Override curl to avoid network calls; the log message happens before the background curl
    const result = runBash(
      `export KEY_SERVER_URL="http://localhost:1"
       export KEY_SERVER_SECRET="secret123"
       MISSING_KEY_PROVIDERS="hetzner vultr"
       # Override curl so the background job completes instantly
       curl() { return 0; }
       export -f curl
       request_missing_cloud_keys 2>&1
       wait 2>/dev/null`,
      { KEY_SERVER_URL: "http://localhost:1", KEY_SERVER_SECRET: "secret123" },
    );
    expect(result.stdout).toContain("Requesting keys for: hetzner vultr");
  });
});

// ============================================================================
// Integration: end-to-end key loading
// ============================================================================

describe("key-request integration", () => {
  it("should load env vars that persist for subsequent commands", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
    });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "my-token" }));

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       load_cloud_keys_from_config 2>/dev/null
       # Verify env var is available for child processes
       bash -c 'echo "child-token=\${HCLOUD_TOKEN}"'`,
    );
    expect(result.stdout).toContain("child-token=my-token");
  });

  it("should handle manifest with mixed auth types", () => {
    createTestManifest({
      hetzner: { auth: "HCLOUD_TOKEN" },
      sprite: { auth: "sprite login" },
      upcloud: { auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD" },
    });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "t1" }));
    writeFileSync(join(configDir, "upcloud.json"), JSON.stringify({ UPCLOUD_USERNAME: "u", UPCLOUD_PASSWORD: "p" }));

    const result = runBash(
      `unset HCLOUD_TOKEN UPCLOUD_USERNAME UPCLOUD_PASSWORD 2>/dev/null
       load_cloud_keys_from_config 2>&1`,
    );
    expect(result.exitCode).toBe(0);
    // 2 API-token clouds (hetzner + upcloud), both loaded; sprite skipped (CLI auth)
    expect(result.stdout).toContain("2/2");
  });

  it("should invalidate and then fail to load a key", () => {
    createTestManifest({ hetzner: { auth: "HCLOUD_TOKEN" } });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "token123" }));

    const result = runBash(
      `unset HCLOUD_TOKEN 2>/dev/null
       # First load should succeed
       load_cloud_keys_from_config 2>/dev/null
       echo "before=\${HCLOUD_TOKEN}"
       # Invalidate the key
       unset HCLOUD_TOKEN 2>/dev/null
       invalidate_cloud_key "hetzner" 2>/dev/null
       # Second load should fail (config file deleted)
       load_cloud_keys_from_config 2>/dev/null
       echo "after=\${HCLOUD_TOKEN:-missing}"`,
    );
    expect(result.stdout).toContain("before=token123");
    expect(result.stdout).toContain("after=missing");
  });

  it("should prefer env vars over config file values", () => {
    createTestManifest({ hetzner: { auth: "HCLOUD_TOKEN" } });
    const configDir = join(testDir, ".config", "spawn");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "hetzner.json"), JSON.stringify({ HCLOUD_TOKEN: "from-config" }));

    const result = runBash(
      `export HCLOUD_TOKEN="from-env"
       load_cloud_keys_from_config 2>/dev/null
       echo "val=\${HCLOUD_TOKEN}"`,
      { HCLOUD_TOKEN: "from-env" },
    );
    // Env var should win over config file
    expect(result.stdout).toContain("val=from-env");
  });
});
