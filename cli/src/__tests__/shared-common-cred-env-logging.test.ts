import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for untested bash functions in shared/common.sh:
 *
 * Logging:
 * - log_info, log_warn, log_error, log_step: colored stderr output
 * - _log_diagnostic: structured diagnostic output (header, causes, fixes)
 *
 * Dependency checks:
 * - check_python_available: python3 existence check
 * - find_node_runtime: bun/node detection
 *
 * Credential management:
 * - _load_token_from_env: env var credential loading
 * - _load_token_from_config: JSON config file credential loading
 * - _save_token_to_config: JSON config file credential saving
 * - _validate_token_with_provider: token validation via callback
 * - _multi_creds_all_env_set: multi-credential env var check
 *
 * Environment injection:
 * - inject_env_vars_local: env var injection for non-SSH providers
 *
 * Temp file management:
 * - track_temp_file + cleanup_temp_files: temp file tracking and cleanup
 *
 * Cloud init:
 * - get_cloud_init_userdata: cloud-init template generation
 *
 * Agent config:
 * - opencode_install_cmd: OpenCode install command generation
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 *
 * Uses a temp file to capture stderr so we can read it even on success.
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const mergedEnv = { ...process.env, ...env };
  const stderrFile = join(tmpdir(), `spawn-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}' 2>"${stderrFile}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
        env: mergedEnv,
      }
    );
    const stderr = existsSync(stderrFile)
      ? readFileSync(stderrFile, "utf-8").trim()
      : "";
    try { rmSync(stderrFile); } catch {}
    return { exitCode: 0, stdout: stdout.trim(), stderr };
  } catch (err: any) {
    const stderr = existsSync(stderrFile)
      ? readFileSync(stderrFile, "utf-8").trim()
      : (err.stderr || "").trim();
    try { rmSync(stderrFile); } catch {}
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Logging functions ─────────────────────────────────────────────────────

describe("log_info", () => {
  it("should output green text to stderr", () => {
    const result = runBash('log_info "Hello world"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Hello world");
    // Green color code
    expect(result.stderr).toContain("\x1b[0;32m");
  });

  it("should output nothing to stdout", () => {
    const result = runBash('log_info "test message"');
    expect(result.stdout).toBe("");
  });
});

describe("log_warn", () => {
  it("should output yellow text to stderr", () => {
    const result = runBash('log_warn "Warning message"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Warning message");
    // Yellow color code
    expect(result.stderr).toContain("\x1b[1;33m");
  });
});

describe("log_error", () => {
  it("should output red text to stderr", () => {
    const result = runBash('log_error "Error occurred"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Error occurred");
    // Red color code
    expect(result.stderr).toContain("\x1b[0;31m");
  });
});

describe("log_step", () => {
  it("should output cyan text to stderr", () => {
    const result = runBash('log_step "Step in progress"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Step in progress");
    // Cyan color code
    expect(result.stderr).toContain("\x1b[0;36m");
  });
});

describe("_log_diagnostic", () => {
  it("should print header, causes, and fixes", () => {
    const result = runBash(
      '_log_diagnostic "Something failed" "Bad network" "Wrong token" "---" "Check connection" "Retry later"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Something failed");
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("Bad network");
    expect(result.stderr).toContain("Wrong token");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("Check connection");
    expect(result.stderr).toContain("Retry later");
  });

  it("should handle single cause and single fix", () => {
    const result = runBash(
      '_log_diagnostic "Error" "One cause" "---" "One fix"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("One cause");
    expect(result.stderr).toContain("One fix");
  });

  it("should number the fix steps", () => {
    const result = runBash(
      '_log_diagnostic "Error" "---" "First step" "Second step" "Third step"'
    );
    expect(result.stderr).toContain("1.");
    expect(result.stderr).toContain("2.");
    expect(result.stderr).toContain("3.");
  });
});

// ── Dependency checks ──────────────────────────────────────────────────────

describe("check_python_available", () => {
  it("should return 0 when python3 is available", () => {
    const result = runBash("check_python_available");
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when python3 is not on PATH", () => {
    const result = runBash("PATH=/nonexistent check_python_available");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Python 3 is required");
  });
});

describe("find_node_runtime", () => {
  it("should find bun or node", () => {
    const result = runBash("find_node_runtime");
    expect(result.exitCode).toBe(0);
    expect(["bun", "node"]).toContain(result.stdout);
  });

  it("should return 1 when neither bun nor node is available", () => {
    const result = runBash("PATH=/nonexistent find_node_runtime");
    expect(result.exitCode).toBe(1);
  });
});

// ── Credential management: _load_token_from_env ────────────────────────────

describe("_load_token_from_env", () => {
  it("should return 0 when env var is set", () => {
    const result = runBash(
      'export MY_TOKEN="abc123"\n_load_token_from_env MY_TOKEN "MyProvider"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Using MyProvider API token from environment");
  });

  it("should return 1 when env var is unset", () => {
    const result = runBash(
      'unset MY_TOKEN\n_load_token_from_env MY_TOKEN "MyProvider"'
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when env var is empty string", () => {
    const result = runBash(
      'export MY_TOKEN=""\n_load_token_from_env MY_TOKEN "MyProvider"'
    );
    expect(result.exitCode).toBe(1);
  });
});

// ── Credential management: _load_token_from_config ─────────────────────────

describe("_load_token_from_config", () => {
  it("should load token from JSON file with api_key field", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ api_key: "my-secret-key" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"\necho "\${MY_TOKEN}"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-secret-key");
    expect(result.stderr).toContain("Using TestProvider API token from");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should load token from JSON file with token field", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ token: "tok-12345" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"\necho "\${MY_TOKEN}"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tok-12345");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should prefer api_key over token when both present", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ api_key: "primary", token: "secondary" })
    );

    const result = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"\necho "\${MY_TOKEN}"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("primary");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file does not exist", () => {
    const result = runBash(
      '_load_token_from_config "/nonexistent/path.json" MY_TOKEN "TestProvider"'
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when config file has no api_key or token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ username: "user" }));

    const result = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
    );
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file is invalid JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "not valid json{{{");

    const result = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
    );
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when api_key and token are both empty strings", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ api_key: "", token: "" })
    );

    const result = runBash(
      `_load_token_from_config "${configFile}" MY_TOKEN "TestProvider"`
    );
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Credential management: _save_token_to_config ───────────────────────────

describe("_save_token_to_config", () => {
  it("should create config file with api_key and token", () => {
    const dir = createTempDir();
    const configFile = join(dir, "sub", "config.json");

    const result = runBash(
      `_save_token_to_config "${configFile}" "my-api-key-123"`
    );
    expect(result.exitCode).toBe(0);

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.api_key).toBe("my-api-key-123");
    expect(content.token).toBe("my-api-key-123");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create parent directories if needed", () => {
    const dir = createTempDir();
    const configFile = join(dir, "deep", "nested", "config.json");

    const result = runBash(
      `_save_token_to_config "${configFile}" "tok"`
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should set file permissions to 600", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_token_to_config "${configFile}" "secret"`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle tokens with special characters", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(
      `_save_token_to_config "${configFile}" 'key-with-"quotes"-and-\\backslash'`
    );

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.api_key).toContain("quotes");
    expect(content.api_key).toContain("backslash");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Credential management: _validate_token_with_provider ────────────────────

describe("_validate_token_with_provider", () => {
  it("should return 0 when test_func is empty (no validation)", () => {
    const result = runBash(
      '_validate_token_with_provider "" MY_TOKEN "Provider"'
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test_func succeeds", () => {
    const result = runBash(
      'my_test() { return 0; }\n_validate_token_with_provider my_test MY_TOKEN "Provider"'
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 and unset env var when test_func fails", () => {
    // Use set +e to prevent early exit so we can check the unset behavior
    const result = runBash(
      'my_test() { return 1; }\nexport MY_TOKEN="abc"\nset +e\n_validate_token_with_provider my_test MY_TOKEN "Provider"\nRET=$?\nset -e\necho "ret=${RET} token=${MY_TOKEN:-UNSET}"'
    );
    expect(result.stdout).toContain("ret=1");
    expect(result.stdout).toContain("token=UNSET");
    expect(result.stderr).toContain("Authentication failed");
  });

  it("should show actionable error message on failure", () => {
    const result = runBash(
      'my_test() { return 1; }\nexport MY_TOKEN="abc"\n_validate_token_with_provider my_test MY_TOKEN "Provider" || true'
    );
    expect(result.stderr).toContain("Invalid Provider API token");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("export MY_TOKEN=");
  });
});

// ── Credential management: _multi_creds_all_env_set ─────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(
      'export VAR_A="a"\nexport VAR_B="b"\n_multi_creds_all_env_set VAR_A VAR_B'
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when one env var is missing", () => {
    const result = runBash(
      'export VAR_A="a"\nunset VAR_B\n_multi_creds_all_env_set VAR_A VAR_B'
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when one env var is empty", () => {
    const result = runBash(
      'export VAR_A="a"\nexport VAR_B=""\n_multi_creds_all_env_set VAR_A VAR_B'
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 0 with single env var set", () => {
    const result = runBash(
      'export ONLY_VAR="x"\n_multi_creds_all_env_set ONLY_VAR'
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when all env vars are unset", () => {
    const result = runBash(
      "unset A B C\n_multi_creds_all_env_set A B C"
    );
    expect(result.exitCode).toBe(1);
  });
});

// ── _multi_creds_validate ───────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when test_func is empty (no validation)", () => {
    const result = runBash('_multi_creds_validate "" "Provider"');
    expect(result.exitCode).toBe(0);
  });

  it("should return 0 when test_func succeeds", () => {
    const result = runBash(
      'ok_test() { return 0; }\n_multi_creds_validate ok_test "Provider" VAR_A VAR_B'
    );
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 and unset all env vars when test_func fails", () => {
    const result = runBash(
      'fail_test() { return 1; }\nexport VAR_A="a" VAR_B="b"\nset +e\n_multi_creds_validate fail_test "Provider" VAR_A VAR_B\nRET=$?\nset -e\necho "ret=${RET} A=${VAR_A:-UNSET} B=${VAR_B:-UNSET}"'
    );
    expect(result.stdout).toContain("ret=1");
    expect(result.stdout).toContain("A=UNSET");
    expect(result.stdout).toContain("B=UNSET");
    expect(result.stderr).toContain("Invalid Provider credentials");
  });
});

// ── Temp file management ─────────────────────────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  it("should clean up tracked temp files", () => {
    const dir = createTempDir();
    const tempFile = join(dir, "tracked_temp");
    writeFileSync(tempFile, "secret data");

    const result = runBash(
      `track_temp_file "${tempFile}"\ncleanup_temp_files`
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(tempFile)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle cleaning up nonexistent files gracefully", () => {
    const result = runBash(
      'track_temp_file "/nonexistent/file/path"\ncleanup_temp_files'
    );
    expect(result.exitCode).toBe(0);
  });

  it("should clean up multiple tracked files", () => {
    const dir = createTempDir();
    const f1 = join(dir, "file1");
    const f2 = join(dir, "file2");
    writeFileSync(f1, "data1");
    writeFileSync(f2, "data2");

    const result = runBash(
      `track_temp_file "${f1}"\ntrack_temp_file "${f2}"\ncleanup_temp_files`
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Cloud-init userdata ─────────────────────────────────────────────────────

describe("get_cloud_init_userdata", () => {
  it("should return valid cloud-config content", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#cloud-config");
  });

  it("should include package install for curl, git, zsh", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("curl");
    expect(result.stdout).toContain("git");
    expect(result.stdout).toContain("zsh");
  });

  it("should include bun and claude code installation", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("bun.sh/install");
    expect(result.stdout).toContain("claude.ai/install.sh");
  });

  it("should signal completion with cloud-init-complete marker", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".cloud-init-complete");
  });
});

// ── generate_env_config ──────────────────────────────────────────────────────

describe("generate_env_config", () => {
  it("should generate export statements for key=value pairs", () => {
    const result = runBash(
      'generate_env_config "KEY1=val1" "KEY2=val2"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KEY1='val1'");
    expect(result.stdout).toContain("export KEY2='val2'");
  });

  it("should include spawn:env marker comment", () => {
    const result = runBash('generate_env_config "X=1"');
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should escape single quotes in values", () => {
    const result = runBash(
      "generate_env_config \"KEY=it's a test\""
    );
    expect(result.exitCode).toBe(0);
    // Single quote should be escaped
    expect(result.stdout).toContain("KEY=");
    expect(result.stdout).not.toContain("KEY='it's");
  });

  it("should handle empty value", () => {
    const result = runBash('generate_env_config "EMPTY="');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export EMPTY=''");
  });
});

// ── opencode_install_cmd ──────────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should return a curl-based install command", () => {
    const result = runBash("opencode_install_cmd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("curl");
  });
});

// ── show_server_name_requirements ────────────────────────────────────────────

describe("show_server_name_requirements", () => {
  it("should output naming rules to stderr", () => {
    const result = runBash("show_server_name_requirements");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("3-63 characters");
    expect(result.stderr).toContain("alphanumeric");
  });
});

// ── _multi_creds_load_config ─────────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("should load multiple fields from JSON config into env vars", () => {
    const dir = createTempDir();
    const configFile = join(dir, "creds.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "admin", password: "s3cret" })
    );

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password\necho "user=\${MY_USER} pass=\${MY_PASS}"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("user=admin pass=s3cret");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when config file is missing", () => {
    const result = runBash(
      '_multi_creds_load_config "/nonexistent.json" 1 MY_VAR key1'
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when a required field is empty in config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "creds.json");
    writeFileSync(
      configFile,
      JSON.stringify({ username: "admin", password: "" })
    );

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password`
    );
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should return 1 when a required field is missing from config", () => {
    const dir = createTempDir();
    const configFile = join(dir, "creds.json");
    writeFileSync(configFile, JSON.stringify({ username: "admin" }));

    const result = runBash(
      `_multi_creds_load_config "${configFile}" 2 MY_USER MY_PASS username password`
    );
    expect(result.exitCode).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── _save_json_config ────────────────────────────────────────────────────────

describe("_save_json_config", () => {
  it("should save key-value pairs as JSON", () => {
    const dir = createTempDir();
    const configFile = join(dir, "out.json");

    const result = runBash(
      `_save_json_config "${configFile}" username admin password secret`
    );
    expect(result.exitCode).toBe(0);

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.username).toBe("admin");
    expect(content.password).toBe("secret");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should create parent directories", () => {
    const dir = createTempDir();
    const configFile = join(dir, "deep", "path", "config.json");

    const result = runBash(
      `_save_json_config "${configFile}" key val`
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(configFile)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("should set file permissions to 600", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    runBash(`_save_json_config "${configFile}" k v`);

    const stats = statSync(configFile);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should handle single key-value pair", () => {
    const dir = createTempDir();
    const configFile = join(dir, "config.json");

    const result = runBash(
      `_save_json_config "${configFile}" api_key test123`
    );
    expect(result.exitCode).toBe(0);

    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.api_key).toBe("test123");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── POLL_INTERVAL configurable ──────────────────────────────────────────────

describe("POLL_INTERVAL", () => {
  it("should default to 1 when SPAWN_POLL_INTERVAL is not set", () => {
    const result = runBash('echo "${POLL_INTERVAL}"', {
      SPAWN_POLL_INTERVAL: "",
    });
    expect(result.stdout).toBe("1");
  });

  it("should use SPAWN_POLL_INTERVAL when set", () => {
    const result = runBash('echo "${POLL_INTERVAL}"', {
      SPAWN_POLL_INTERVAL: "0.1",
    });
    expect(result.stdout).toBe("0.1");
  });
});

// ── Color variable definitions ──────────────────────────────────────────────

describe("color variables", () => {
  it("should define RED, GREEN, YELLOW, CYAN, NC", () => {
    const result = runBash(
      'echo "${RED}${GREEN}${YELLOW}${CYAN}${NC}" | cat -v'
    );
    expect(result.exitCode).toBe(0);
    // Should contain escape sequences (^[[ in cat -v output)
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

// ── register_cleanup_trap ───────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should register EXIT trap for cleanup_temp_files", () => {
    const result = runBash(
      'register_cleanup_trap\ntrap -p EXIT'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should register INT trap for cleanup_temp_files", () => {
    const result = runBash(
      'register_cleanup_trap\ntrap -p INT'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });

  it("should register TERM trap for cleanup_temp_files", () => {
    const result = runBash(
      'register_cleanup_trap\ntrap -p TERM'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_temp_files");
  });
});

// ── validate_server_name ────────────────────────────────────────────────────

describe("validate_server_name", () => {
  it("should accept valid server names (3-63 chars, alphanumeric + dash)", () => {
    const validNames = ["my-server", "test123", "abc", "spawn-server-01", "MyServer"];
    for (const name of validNames) {
      const result = runBash(`validate_server_name "${name}"`);
      expect(result.exitCode).toBe(0);
    }
  });

  it("should reject names starting with hyphen", () => {
    const result = runBash('validate_server_name "-badname"');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot start or end with dash");
  });

  it("should reject names ending with hyphen", () => {
    const result = runBash('validate_server_name "badname-"');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot start or end with dash");
  });

  it("should reject empty names", () => {
    const result = runBash('validate_server_name ""');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot be empty");
  });

  it("should reject names with special characters", () => {
    const result = runBash('validate_server_name "test@server"');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must contain only alphanumeric");
  });

  it("should reject names exceeding 63 characters", () => {
    const longName = "a".repeat(64);
    const result = runBash(`validate_server_name "${longName}"`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("too long");
  });

  it("should accept names exactly 63 characters", () => {
    const name = "a".repeat(63);
    const result = runBash(`validate_server_name "${name}"`);
    expect(result.exitCode).toBe(0);
  });

  it("should reject names shorter than 3 characters", () => {
    const result = runBash('validate_server_name "ab"');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("too short");
  });

  it("should accept names exactly 3 characters", () => {
    const result = runBash('validate_server_name "abc"');
    expect(result.exitCode).toBe(0);
  });
});
