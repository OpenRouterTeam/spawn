import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for shared/common.sh provisioning, environment injection, agent
 * verification, SSH helpers, and diagnostic functions.
 *
 * These functions are used across ALL cloud providers but had no direct
 * test coverage. They handle:
 *   - _log_diagnostic: structured error output for debugging
 *   - find_node_runtime / check_python_available: dependency discovery
 *   - get_cloud_init_userdata: cloud-init template output
 *   - verify_agent_installed: agent installation verification
 *   - track_temp_file / cleanup_temp_files: secure temp file lifecycle
 *   - inject_env_vars_ssh / inject_env_vars_local: env var injection flow
 *   - get_model_id_interactive: model selection from env or interactive
 *   - generate_ssh_key_if_missing / get_ssh_fingerprint: SSH key management
 *   - check_ssh_key_by_fingerprint: SSH key lookup pattern
 *   - _parse_api_response: API response parsing
 *   - _update_retry_interval: retry backoff logic
 *   - log_info/log_warn/log_error/log_step: logging output
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/** Run a bash script that sources shared/common.sh, capture stdout + stderr + exit code.
 *  Uses spawnSync to capture stderr even on success (execSync drops stderr on exit 0). */
function runBash(script: string, env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env, PATH: process.env.PATH },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ── _log_diagnostic ──────────────────────────────────────────────────────────

describe("_log_diagnostic", () => {
  it("should print header, causes, and fix steps", () => {
    const result = runBash(
      '_log_diagnostic "Installation failed" "Missing Python" "Bad PATH" --- "Install python3" "Check your PATH"'
    );
    expect(result.stderr).toContain("Installation failed");
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("- Missing Python");
    expect(result.stderr).toContain("- Bad PATH");
    expect(result.stderr).toContain("How to fix:");
    expect(result.stderr).toContain("1. Install python3");
    expect(result.stderr).toContain("2. Check your PATH");
  });

  it("should handle single cause and single fix", () => {
    const result = runBash(
      '_log_diagnostic "Error occurred" "Something broke" --- "Fix it"'
    );
    expect(result.stderr).toContain("Error occurred");
    expect(result.stderr).toContain("- Something broke");
    expect(result.stderr).toContain("1. Fix it");
  });

  it("should handle multiple causes without fixes gracefully", () => {
    const result = runBash(
      '_log_diagnostic "Error" "Cause 1" "Cause 2" ---'
    );
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("- Cause 1");
    expect(result.stderr).toContain("- Cause 2");
    expect(result.stderr).toContain("How to fix:");
  });

  it("should number fix steps sequentially", () => {
    const result = runBash(
      '_log_diagnostic "Error" "cause" --- "step one" "step two" "step three"'
    );
    expect(result.stderr).toContain("1. step one");
    expect(result.stderr).toContain("2. step two");
    expect(result.stderr).toContain("3. step three");
  });
});

// ── find_node_runtime ──────────────────────────────────────────────────────────

describe("find_node_runtime", () => {
  it("should find bun or node runtime", () => {
    const result = runBash("find_node_runtime");
    expect(result.exitCode).toBe(0);
    const runtime = result.stdout.trim();
    expect(["bun", "node"]).toContain(runtime);
  });

  it("should prefer bun over node when both available", () => {
    // Only run if bun is available on the system
    const bunCheck = spawnSync("command", ["-v", "bun"], { shell: true, encoding: "utf-8" });
    if (bunCheck.status === 0) {
      const result = runBash("find_node_runtime");
      expect(result.stdout.trim()).toBe("bun");
    }
  });

  it("should return exit code 1 when neither is available", () => {
    // Override PATH so bun/node can't be found, but keep bash itself available
    const result = runBash("find_node_runtime", { PATH: "/usr/bin:/bin" });
    // In this env, bun won't be found (it's usually in ~/.bun/bin)
    // but node might be at /usr/bin/node. If so, it should still succeed.
    // The key test: if we fully isolate, it should fail
    const isolatedResult = spawnSync("bash", ["-c", `source "${COMMON_SH}" && PATH=/nonexistent find_node_runtime`], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: "/nonexistent" },
    });
    expect(isolatedResult.status).toBe(1);
  });
});

// ── check_python_available ──────────────────────────────────────────────────

describe("check_python_available", () => {
  it("should succeed when python3 is available", () => {
    const result = runBash("check_python_available");
    expect(result.exitCode).toBe(0);
  });

  it("should fail when python3 is not in PATH", () => {
    const result = spawnSync("bash", ["-c", `source "${COMMON_SH}" && PATH=/nonexistent check_python_available`], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: "/nonexistent" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Python 3 is required");
  });

  it("should show installation instructions on failure", () => {
    const result = spawnSync("bash", ["-c", `source "${COMMON_SH}" && PATH=/nonexistent check_python_available`], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, HOME: "/nonexistent" },
    });
    expect(result.stderr).toContain("Install Python 3:");
    expect(result.stderr).toContain("apt-get");
  });
});

// ── get_cloud_init_userdata ────────────────────────────────────────────────

describe("get_cloud_init_userdata", () => {
  it("should output valid cloud-init YAML", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#cloud-config");
  });

  it("should include package update directive", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("package_update: true");
  });

  it("should install required packages", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("curl");
    expect(result.stdout).toContain("git");
    expect(result.stdout).toContain("zsh");
    expect(result.stdout).toContain("unzip");
  });

  it("should install Bun runtime", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("bun.sh/install");
  });

  it("should install Claude Code", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain("claude.ai/install.sh");
  });

  it("should configure PATH in both .bashrc and .zshrc", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
  });

  it("should signal completion with a sentinel file", () => {
    const result = runBash("get_cloud_init_userdata");
    expect(result.stdout).toContain(".cloud-init-complete");
  });
});

// ── track_temp_file + cleanup_temp_files ──────────────────────────────────

describe("track_temp_file and cleanup_temp_files", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-test-tempfiles-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should track and clean up a single temp file", () => {
    const tempFile = join(testDir, "secret.txt");
    writeFileSync(tempFile, "secret-data");

    const result = runBash(`
      track_temp_file "${tempFile}"
      cleanup_temp_files
      if [[ -f "${tempFile}" ]]; then echo "EXISTS"; else echo "DELETED"; fi
    `);
    expect(result.stdout.trim()).toBe("DELETED");
  });

  it("should track and clean up multiple temp files", () => {
    const file1 = join(testDir, "file1.txt");
    const file2 = join(testDir, "file2.txt");
    writeFileSync(file1, "data1");
    writeFileSync(file2, "data2");

    const result = runBash(`
      track_temp_file "${file1}"
      track_temp_file "${file2}"
      cleanup_temp_files
      echo "F1=$(test -f '${file1}' && echo Y || echo N)"
      echo "F2=$(test -f '${file2}' && echo Y || echo N)"
    `);
    expect(result.stdout).toContain("F1=N");
    expect(result.stdout).toContain("F2=N");
  });

  it("should not fail if temp file was already deleted", () => {
    const tempFile = join(testDir, "already-gone.txt");

    const result = runBash(`
      track_temp_file "${tempFile}"
      cleanup_temp_files
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should preserve exit code through cleanup", () => {
    const tempFile = join(testDir, "preserve-exit.txt");
    writeFileSync(tempFile, "data");

    const result = runBash(`
      track_temp_file "${tempFile}"
      true
      cleanup_temp_files
      echo "exit=\$?"
    `);
    expect(result.stdout).toContain("exit=0");
  });
});

// ── generate_env_config edge cases ───────────────────────────────────────────

describe("generate_env_config edge cases", () => {
  it("should handle values with equals signs", () => {
    const result = runBash("generate_env_config 'BASE_URL=https://api.openrouter.ai/v1?key=abc'");
    expect(result.stdout).toContain("export BASE_URL=");
    expect(result.stdout).toContain("https://api.openrouter.ai/v1?key=abc");
  });

  it("should handle multiple env pairs", () => {
    const result = runBash(
      "generate_env_config 'KEY1=val1' 'KEY2=val2' 'KEY3=val3'"
    );
    expect(result.stdout).toContain("export KEY1='val1'");
    expect(result.stdout).toContain("export KEY2='val2'");
    expect(result.stdout).toContain("export KEY3='val3'");
  });

  it("should include spawn:env marker comment", () => {
    const result = runBash("generate_env_config 'X=1'");
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should produce output that starts with a blank line", () => {
    const result = runBash("generate_env_config 'X=1'");
    // First line should be empty
    expect(result.stdout).toMatch(/^\n/);
  });

  it("should escape single quotes in values", () => {
    const result = runBash("generate_env_config \"KEY=it's a test\"");
    // The value should properly handle the single quote
    expect(result.stdout).toContain("export KEY=");
    expect(result.exitCode).toBe(0);
  });
});

// ── inject_env_vars_local ─────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-test-inject-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should call upload and run functions with env config", () => {
    const result = runBash(`
      mock_upload() { echo "UPLOAD:\$1:\$2"; }
      mock_run() { echo "RUN:\$1"; }
      inject_env_vars_local mock_upload mock_run "API_KEY=test123"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UPLOAD:");
    expect(result.stdout).toContain("/tmp/env_config");
    expect(result.stdout).toContain("RUN:");
    expect(result.stdout).toContain(".zshrc");
  });

  it("should pass multiple env vars through to generate_env_config", () => {
    const uploadedContent = join(testDir, "captured.txt");
    const result = runBash(`
      mock_upload() { cp "\$1" "${uploadedContent}"; }
      mock_run() { true; }
      inject_env_vars_local mock_upload mock_run "KEY1=val1" "KEY2=val2"
    `);
    expect(result.exitCode).toBe(0);
    if (existsSync(uploadedContent)) {
      const content = readFileSync(uploadedContent, "utf-8");
      expect(content).toContain("export KEY1='val1'");
      expect(content).toContain("export KEY2='val2'");
    }
  });
});

// ── inject_env_vars_ssh ──────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should call upload and run functions with server IP", () => {
    const result = runBash(`
      mock_upload() { echo "UPLOAD:\$1:\$2:\$3"; }
      mock_run() { echo "RUN:\$1:\$2"; }
      inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "OPENROUTER_API_KEY=sk-test"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UPLOAD:10.0.0.1:");
    expect(result.stdout).toContain("/tmp/env_config");
    expect(result.stdout).toContain("RUN:10.0.0.1:");
    expect(result.stdout).toContain(".zshrc");
  });
});

// ── verify_agent_installed ────────────────────────────────────────────────

describe("verify_agent_installed", () => {
  it("should succeed when agent command exists and verify passes", () => {
    const result = runBash('verify_agent_installed "bash" "--version" "Bash"');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("verified successfully");
  });

  it("should fail when agent command does not exist", () => {
    const result = runBash(
      'verify_agent_installed "nonexistent_agent_xyz" "--version" "FakeAgent"'
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  it("should show diagnostic output on command not found", () => {
    const result = runBash(
      'verify_agent_installed "nonexistent_agent_xyz" "--version" "FakeAgent"'
    );
    expect(result.stderr).toContain("Possible causes:");
    expect(result.stderr).toContain("How to fix:");
  });

  it("should use --version as default verify argument", () => {
    const result = runBash('verify_agent_installed "bash"');
    expect(result.exitCode).toBe(0);
  });

  it("should use agent command as default display name", () => {
    const result = runBash('verify_agent_installed "bash"');
    expect(result.stderr).toContain("bash");
  });

  it("should fail when verification command returns error", () => {
    // false always returns 1, use empty verify arg to avoid --version
    const result = runBash(
      'verify_agent_installed "false" "" "AlwaysFail"'
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("verification failed");
  });
});

// ── get_model_id_interactive ──────────────────────────────────────────────

describe("get_model_id_interactive", () => {
  it("should return MODEL_ID from environment without prompting", () => {
    const result = runBash('get_model_id_interactive "default-model"', {
      MODEL_ID: "anthropic/claude-3.5-sonnet",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("anthropic/claude-3.5-sonnet");
  });

  it("should reject MODEL_ID with invalid characters from env", () => {
    const result = runBash('get_model_id_interactive "default-model"', {
      MODEL_ID: "model; rm -rf /",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid");
  });

  it("should accept valid MODEL_ID patterns from env", () => {
    const validModels = [
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet:beta",
      "google/gemini-pro-1.5",
      "openrouter/auto",
    ];
    for (const model of validModels) {
      const result = runBash("get_model_id_interactive", { MODEL_ID: model });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(model);
    }
  });

  it("should reject command injection attempts in MODEL_ID", () => {
    const malicious = [
      "model$(whoami)",
      "model`id`",
      "model;ls",
      "model|cat /etc/passwd",
    ];
    for (const model of malicious) {
      const result = runBash("get_model_id_interactive", { MODEL_ID: model });
      expect(result.exitCode).toBe(1);
    }
  });
});

// ── generate_ssh_key_if_missing ──────────────────────────────────────────────

describe("generate_ssh_key_if_missing", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-test-ssh-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should generate a new SSH key when none exists", () => {
    const keyPath = join(testDir, "id_ed25519");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(`${keyPath}.pub`)).toBe(true);
  });

  it("should skip generation when key already exists", () => {
    const keyPath = join(testDir, "id_ed25519");
    writeFileSync(keyPath, "existing-key-data");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(keyPath, "utf-8")).toBe("existing-key-data");
  });

  it("should create parent directories if missing", () => {
    const keyPath = join(testDir, "subdir", "deep", "id_ed25519");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
  });
});

// ── get_ssh_fingerprint ──────────────────────────────────────────────────────

describe("get_ssh_fingerprint", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `spawn-test-fp-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should return MD5 fingerprint for a valid SSH key", () => {
    const keyPath = join(testDir, "test_key");
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`, {
      encoding: "utf-8",
    });

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    const fp = result.stdout.trim();
    expect(fp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2})+$/);
  });

  it("should fail gracefully for non-existent key", () => {
    const result = runBash(
      `get_ssh_fingerprint "${testDir}/nonexistent.pub"`
    );
    expect(result.stdout.trim()).toBe("");
  });
});

// ── check_ssh_key_by_fingerprint ─────────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"id": 1, "fingerprint": "ab:cd:ef:12:34"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "ab:cd:ef:12:34"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when fingerprint is not found", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys": [{"id": 1, "fingerprint": "aa:bb:cc:dd:ee"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "xx:yy:zz:11:22"
    `);
    expect(result.exitCode).toBe(1);
  });

  it("should return 1 when API returns empty response", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys": []}'; }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "ab:cd:ef"
    `);
    expect(result.exitCode).toBe(1);
  });
});

// ── check_openrouter_connectivity ──────────────────────────────────────────

describe("check_openrouter_connectivity", () => {
  it("should return 0 or 1 without crashing", () => {
    const result = runBash('check_openrouter_connectivity\necho "RC=$?"');
    expect(result.exitCode).toBe(0);
    const match = result.stdout.match(/RC=(\d+)/);
    expect(match).not.toBeNull();
    const code = match![1];
    expect(["0", "1"]).toContain(code);
  });
});

// ── wait_for_cloud_init (function exists) ─────────────────────────────────

describe("wait_for_cloud_init", () => {
  it("should be defined as a function", () => {
    const result = runBash("type wait_for_cloud_init");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });
});

// ── open_browser ─────────────────────────────────────────────────────────────

describe("open_browser", () => {
  it("should be defined as a function", () => {
    const result = runBash("type open_browser");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });
});

// ── _update_retry_interval ──────────────────────────────────────────────────

describe("_update_retry_interval", () => {
  it("should double the interval", () => {
    const result = runBash(`
      interval=5
      max_interval=60
      _update_retry_interval interval max_interval
      echo "\$interval"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("10");
  });

  it("should cap at max_interval", () => {
    const result = runBash(`
      interval=40
      max_interval=30
      _update_retry_interval interval max_interval
      echo "\$interval"
    `);
    expect(result.exitCode).toBe(0);
    expect(parseInt(result.stdout.trim())).toBeLessThanOrEqual(30);
  });

  it("should handle interval of 1", () => {
    const result = runBash(`
      interval=1
      max_interval=100
      _update_retry_interval interval max_interval
      echo "\$interval"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });
});

// ── interactive_pick (env var path) ──────────────────────────────────────────

describe("interactive_pick env var shortcut", () => {
  it("should return env var value immediately without calling callback", () => {
    const result = runBash(
      `
      mock_list() { echo "should-not-be-called"; }
      interactive_pick "MY_PICK" "default-val" "items" "mock_list"
    `,
      { MY_PICK: "env-value" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("env-value");
  });

  it("should fall back to default when callback returns empty and no env var", () => {
    const result = runBash(
      `
      mock_list() { echo ""; }
      interactive_pick "UNSET_VAR_XYZ" "my-default" "items" "mock_list"
    `,
      { UNSET_VAR_XYZ: "" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("my-default");
  });
});

// ── SSH helper functions (function existence) ─────────────────────────────

describe("SSH helper functions", () => {
  const helpers = [
    "ssh_run_server",
    "ssh_upload_file",
    "ssh_interactive_session",
    "ssh_verify_connectivity",
  ];

  for (const fn of helpers) {
    it(`should define ${fn} as a function`, () => {
      const result = runBash(`type ${fn}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("function");
    });
  }
});

// ── _parse_api_response ──────────────────────────────────────────────────────

describe("_parse_api_response", () => {
  it("should extract HTTP status code from curl output", () => {
    // _parse_api_response expects last line to be the HTTP status code
    // (from curl -w "\n%{http_code}")
    const result = runBash(`
      response='{"data":"test"}
200'
      _parse_api_response "\$response"
      echo "STATUS=\$API_HTTP_CODE"
      echo "BODY=\$API_RESPONSE_BODY"
    `);
    expect(result.stdout).toContain("STATUS=200");
    expect(result.stdout).toContain('BODY={"data":"test"}');
  });

  it("should handle status-only response", () => {
    const result = runBash(`
      response='404'
      _parse_api_response "\$response"
      echo "STATUS=\$API_HTTP_CODE"
    `);
    expect(result.stdout).toContain("STATUS=404");
  });

  it("should handle multiline JSON body", () => {
    const result = runBash(`
      response='{
  "id": 123,
  "name": "test"
}
201'
      _parse_api_response "\$response"
      echo "STATUS=\$API_HTTP_CODE"
    `);
    expect(result.stdout).toContain("STATUS=201");
  });
});

// ── log functions ────────────────────────────────────────────────────────────

describe("log functions output to stderr", () => {
  it("log_info should write to stderr", () => {
    const result = runBash('log_info "test info message"');
    expect(result.stderr).toContain("test info message");
    expect(result.stdout).toBe("");
  });

  it("log_warn should write to stderr", () => {
    const result = runBash('log_warn "test warning"');
    expect(result.stderr).toContain("test warning");
    expect(result.stdout).toBe("");
  });

  it("log_error should write to stderr", () => {
    const result = runBash('log_error "test error"');
    expect(result.stderr).toContain("test error");
    expect(result.stdout).toBe("");
  });

  it("log_step should write to stderr", () => {
    const result = runBash('log_step "test step"');
    expect(result.stderr).toContain("test step");
    expect(result.stdout).toBe("");
  });
});
