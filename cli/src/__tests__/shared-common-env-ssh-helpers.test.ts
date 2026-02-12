import { describe, it, expect } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for env injection, multi-credential, SSH key, and utility functions
 * in shared/common.sh that previously had zero test coverage:
 *
 * - inject_env_vars_ssh: injects env vars into remote server shell config via SSH
 * - inject_env_vars_local: injects env vars for non-SSH providers (modal, sprite)
 * - _multi_creds_all_env_set: checks if all required env vars are set
 * - _multi_creds_load_config: loads credentials from JSON config into env vars
 * - _multi_creds_validate: validates credentials with a test function
 * - check_ssh_key_by_fingerprint: checks SSH key registration with provider API
 * - opencode_install_cmd: generates robust install command for OpenCode
 * - track_temp_file / cleanup_temp_files: temporary file lifecycle management
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
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-env-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── inject_env_vars_ssh ──────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should call upload and run functions with correct arguments", () => {
    const tmpDir = createTempDir();
    try {
      // Create mock upload and run functions that record their calls
      const result = runBash(`
        UPLOAD_CALLS="${tmpDir}/upload_calls.txt"
        RUN_CALLS="${tmpDir}/run_calls.txt"

        mock_upload() {
          echo "upload: ip=\$1 src=\$2 dst=\$3" >> "\${UPLOAD_CALLS}"
        }

        mock_run() {
          echo "run: ip=\$1 cmd=\$2" >> "\${RUN_CALLS}"
        }

        inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "FOO=bar" "BAZ=qux"

        echo "upload_calls:"
        cat "\${UPLOAD_CALLS}"
        echo "run_calls:"
        cat "\${RUN_CALLS}"
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("upload: ip=10.0.0.1");
      expect(result.stdout).toContain("dst=/tmp/env_config");
      expect(result.stdout).toContain("run: ip=10.0.0.1");
      expect(result.stdout).toContain("cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should generate correct env config content in the uploaded file", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        CAPTURED_SRC="${tmpDir}/captured_src.txt"

        mock_upload() {
          cp "\$2" "\${CAPTURED_SRC}"
        }

        mock_run() {
          true
        }

        inject_env_vars_ssh "10.0.0.1" mock_upload mock_run \
          "OPENROUTER_API_KEY=sk-test-123" \
          "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

        cat "\${CAPTURED_SRC}"
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("# [spawn:env]");
      expect(result.stdout).toContain("export OPENROUTER_API_KEY='sk-test-123'");
      expect(result.stdout).toContain("export ANTHROPIC_BASE_URL='https://openrouter.ai/api'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle values with single quotes (escaping)", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        CAPTURED="${tmpDir}/captured.txt"

        mock_upload() { cp "\$2" "\${CAPTURED}"; }
        mock_run() { true; }

        inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY=it's a test"

        cat "\${CAPTURED}"
      `);

      expect(result.exitCode).toBe(0);
      // Single quotes in values should be escaped
      expect(result.stdout).toContain("export KEY=");
      // The value should be properly escaped so it can be sourced without breaking
      expect(result.stdout).not.toContain("export KEY='it's a test'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should create temp file with restrictive permissions (600)", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        CAPTURED_PERMS="${tmpDir}/perms.txt"

        mock_upload() {
          stat -c '%a' "\$2" > "\${CAPTURED_PERMS}" 2>/dev/null || stat -f '%Lp' "\$2" > "\${CAPTURED_PERMS}" 2>/dev/null
        }
        mock_run() { true; }

        inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "SECRET=value"

        cat "\${CAPTURED_PERMS}"
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("600");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── inject_env_vars_local ────────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload and run without server IP argument", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        UPLOAD_CALLS="${tmpDir}/upload.txt"
        RUN_CALLS="${tmpDir}/run.txt"

        mock_upload() {
          echo "upload: src=\$1 dst=\$2" >> "\${UPLOAD_CALLS}"
        }

        mock_run() {
          echo "run: cmd=\$1" >> "\${RUN_CALLS}"
        }

        inject_env_vars_local mock_upload mock_run "FOO=bar" "BAZ=qux"

        echo "upload_calls:"
        cat "\${UPLOAD_CALLS}"
        echo "run_calls:"
        cat "\${RUN_CALLS}"
      `);

      expect(result.exitCode).toBe(0);
      // local variant: upload(src, dst) - no IP
      expect(result.stdout).toContain("upload: src=");
      expect(result.stdout).toContain("dst=/tmp/env_config");
      // local variant: run(cmd) - no IP
      expect(result.stdout).toContain("run: cmd=cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should generate correct env config for local injection", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        CAPTURED="${tmpDir}/captured.txt"

        mock_upload() { cp "\$1" "\${CAPTURED}"; }
        mock_run() { true; }

        inject_env_vars_local mock_upload mock_run \
          "OPENAI_API_KEY=sk-test" \
          "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

        cat "\${CAPTURED}"
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("# [spawn:env]");
      expect(result.stdout).toContain("export OPENAI_API_KEY='sk-test'");
      expect(result.stdout).toContain("export OPENAI_BASE_URL='https://openrouter.ai/api/v1'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle empty value in env var", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        CAPTURED="${tmpDir}/captured.txt"

        mock_upload() { cp "\$1" "\${CAPTURED}"; }
        mock_run() { true; }

        inject_env_vars_local mock_upload mock_run "ANTHROPIC_API_KEY="

        cat "\${CAPTURED}"
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export ANTHROPIC_API_KEY=''");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── _multi_creds_all_env_set ─────────────────────────────────────────────────

describe("_multi_creds_all_env_set", () => {
  it("should return 0 when all env vars are set", () => {
    const result = runBash(
      '_multi_creds_all_env_set VAR_A VAR_B VAR_C; echo $?',
      { VAR_A: "val_a", VAR_B: "val_b", VAR_C: "val_c" }
    );
    expect(result.stdout).toBe("0");
  });

  it("should return 1 when any env var is empty", () => {
    const result = runBash(
      '_multi_creds_all_env_set VAR_A VAR_B; echo $?',
      { VAR_A: "val_a", VAR_B: "" }
    );
    expect(result.stdout).toBe("1");
  });

  it("should return 1 when any env var is unset", () => {
    const result = runBash(
      'unset MISSING_VAR; _multi_creds_all_env_set VAR_A MISSING_VAR; echo $?',
      { VAR_A: "val_a" }
    );
    expect(result.stdout).toBe("1");
  });

  it("should return 0 for a single set env var", () => {
    const result = runBash(
      '_multi_creds_all_env_set SOLO_VAR; echo $?',
      { SOLO_VAR: "value" }
    );
    expect(result.stdout).toBe("0");
  });

  it("should return 0 with no arguments (vacuously true)", () => {
    const result = runBash('_multi_creds_all_env_set; echo $?');
    expect(result.stdout).toBe("0");
  });

  it("should handle env vars with special characters in values", () => {
    const result = runBash(
      '_multi_creds_all_env_set SPECIAL_VAR; echo $?',
      { SPECIAL_VAR: "has spaces & special=chars" }
    );
    expect(result.stdout).toBe("0");
  });
});

// ── _multi_creds_load_config ─────────────────────────────────────────────────

describe("_multi_creds_load_config", () => {
  it("should load credentials from JSON config file into env vars", () => {
    const tmpDir = createTempDir();
    const configFile = join(tmpDir, "creds.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "my-client-id",
      client_secret: "my-secret",
    }));

    try {
      const result = runBash(`
        _multi_creds_load_config "${configFile}" 2 MY_CLIENT_ID MY_CLIENT_SECRET client_id client_secret
        echo "id=\${MY_CLIENT_ID}"
        echo "secret=\${MY_CLIENT_SECRET}"
      `);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("id=my-client-id");
      expect(result.stdout).toContain("secret=my-secret");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return 1 when config file is missing", () => {
    const result = runBash(`
      _multi_creds_load_config "/nonexistent/creds.json" 1 MY_VAR some_key
      echo "exit=\$?"
    `);

    expect(result.stdout).toContain("exit=1");
  });

  it("should return 1 when a field is missing from config", () => {
    const tmpDir = createTempDir();
    const configFile = join(tmpDir, "partial.json");
    writeFileSync(configFile, JSON.stringify({
      client_id: "my-id",
      // client_secret is missing
    }));

    try {
      const result = runBash(`
        _multi_creds_load_config "${configFile}" 2 MY_ID MY_SECRET client_id client_secret
        echo "exit=\$?"
      `);

      expect(result.stdout).toContain("exit=1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return 1 for invalid JSON config", () => {
    const tmpDir = createTempDir();
    const configFile = join(tmpDir, "bad.json");
    writeFileSync(configFile, "not json {{{");

    try {
      const result = runBash(`
        _multi_creds_load_config "${configFile}" 1 MY_VAR some_key
        echo "exit=\$?"
      `);

      expect(result.stdout).toContain("exit=1");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── _multi_creds_validate ────────────────────────────────────────────────────

describe("_multi_creds_validate", () => {
  it("should return 0 when test function succeeds", () => {
    const result = runBash(`
      test_ok() { return 0; }
      _multi_creds_validate test_ok "TestProvider" MY_VAR
      echo "exit=\$?"
    `, { MY_VAR: "value" });

    expect(result.stdout).toContain("exit=0");
  });

  it("should return 1 and unset env vars when test function fails", () => {
    const result = runBash(`
      export MY_TOKEN="secret"
      test_fail() { return 1; }
      _multi_creds_validate test_fail "TestProvider" MY_TOKEN
      echo "exit=\$?"
      echo "token=\${MY_TOKEN:-UNSET}"
    `);

    expect(result.stdout).toContain("exit=1");
    expect(result.stdout).toContain("token=UNSET");
  });

  it("should unset all listed env vars on failure", () => {
    const result = runBash(`
      export VAR_A="a" VAR_B="b" VAR_C="c"
      test_fail() { return 1; }
      _multi_creds_validate test_fail "Provider" VAR_A VAR_B VAR_C
      echo "a=\${VAR_A:-UNSET} b=\${VAR_B:-UNSET} c=\${VAR_C:-UNSET}"
    `);

    expect(result.stdout).toContain("a=UNSET b=UNSET c=UNSET");
  });

  it("should return 0 immediately when test_func is empty string", () => {
    const result = runBash(`
      _multi_creds_validate "" "Provider" SOME_VAR
      echo "exit=\$?"
    `);

    expect(result.stdout).toContain("exit=0");
  });

  it("should log error messages on failure", () => {
    const result = runBash(`
      test_fail() { return 1; }
      _multi_creds_validate test_fail "Contabo" CONTABO_TOKEN
    `);

    expect(result.stderr).toContain("Invalid Contabo credentials");
    expect(result.stderr).toContain("expired, revoked, or incorrectly copied");
  });
});

// ── check_ssh_key_by_fingerprint ─────────────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys":[{"id":1,"fingerprint":"SHA256:abc123def456"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "SHA256:abc123def456"
      echo "exit=\$?"
    `);

    expect(result.stdout).toContain("exit=0");
  });

  it("should return 1 when fingerprint is not found", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys":[{"id":1,"fingerprint":"SHA256:other_key"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "SHA256:abc123def456"
      echo "exit=\$?"
    `);

    expect(result.stdout).toContain("exit=1");
  });

  it("should return 1 when API returns empty response", () => {
    const result = runBash(`
      mock_api() {
        echo '{"ssh_keys":[]}'
      }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "SHA256:abc123"
      echo "exit=\$?"
    `);

    expect(result.stdout).toContain("exit=1");
  });

  it("should pass GET method and endpoint to the API function", () => {
    const tmpDir = createTempDir();
    try {
      const result = runBash(`
        CALL_LOG="${tmpDir}/calls.txt"
        mock_api() {
          echo "method=\$1 endpoint=\$2" >> "\${CALL_LOG}"
          echo '{"ssh_keys":[{"fingerprint":"fp123"}]}'
        }
        check_ssh_key_by_fingerprint mock_api "/v2/ssh_keys" "fp123"

        cat "\${CALL_LOG}"
      `);

      expect(result.stdout).toContain("method=GET endpoint=/v2/ssh_keys");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── opencode_install_cmd ─────────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should output a non-empty install command string", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(50);
  });

  it("should include architecture detection (uname -m)", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain("uname -m");
  });

  it("should include OS detection (uname -s)", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain("uname -s");
  });

  it("should download from opencode-ai GitHub releases", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain("github.com/opencode-ai/opencode/releases");
  });

  it("should install to $HOME/.opencode/bin", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain(".opencode/bin");
  });

  it("should update both .bashrc and .zshrc PATH", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
  });

  it("should handle aarch64 to arm64 mapping", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain('aarch64');
    expect(result.stdout).toContain('arm64');
  });

  it("should handle darwin to mac OS mapping", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain("darwin");
    expect(result.stdout).toContain("mac");
  });

  it("should clean up temp files after extraction", () => {
    const result = runBash('opencode_install_cmd');

    expect(result.stdout).toContain("rm -rf /tmp/opencode-install");
  });

  it("should produce a command that passes bash -n syntax check", () => {
    const cmd = runBash('opencode_install_cmd').stdout;
    const result = runBash(`bash -n <<'SYNTAX_CHECK'\n${cmd}\nSYNTAX_CHECK`);

    expect(result.exitCode).toBe(0);
  });
});

// ── track_temp_file / cleanup_temp_files ─────────────────────────────────────

describe("temp file lifecycle", () => {
  it("should track and cleanup temp files on exit", () => {
    const tmpDir = createTempDir();
    try {
      const tmpFile = join(tmpDir, "secret.txt");
      writeFileSync(tmpFile, "sensitive data");

      const result = runBash(`
        register_cleanup_trap
        track_temp_file "${tmpFile}"
        cleanup_temp_files
        if [[ -f "${tmpFile}" ]]; then
          echo "FILE_EXISTS"
        else
          echo "FILE_REMOVED"
        fi
      `);

      expect(result.stdout).toBe("FILE_REMOVED");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should handle cleanup of non-existent files without error", () => {
    const result = runBash(`
      track_temp_file "/tmp/nonexistent-file-${Date.now()}"
      cleanup_temp_files
      echo "exit=\$?"
    `);

    expect(result.stdout).toContain("exit=0");
  });

  it("should track multiple temp files", () => {
    const tmpDir = createTempDir();
    try {
      const files = [
        join(tmpDir, "a.txt"),
        join(tmpDir, "b.txt"),
        join(tmpDir, "c.txt"),
      ];
      for (const f of files) writeFileSync(f, "data");

      const result = runBash(`
        register_cleanup_trap
        track_temp_file "${files[0]}"
        track_temp_file "${files[1]}"
        track_temp_file "${files[2]}"
        cleanup_temp_files

        remaining=0
        for f in "${files[0]}" "${files[1]}" "${files[2]}"; do
          [[ -f "\$f" ]] && remaining=\$((remaining + 1))
        done
        echo "remaining=\${remaining}"
      `);

      expect(result.stdout).toContain("remaining=0");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve exit code through cleanup", () => {
    const result = runBash(`
      cleanup_temp_files
      echo "preserved=\$?"
    `);

    // cleanup_temp_files preserves the exit code it captured
    expect(result.stdout).toContain("preserved=0");
  });
});

// ── generate_env_config edge cases ───────────────────────────────────────────

describe("generate_env_config edge cases", () => {
  it("should handle values containing equals signs", () => {
    const result = runBash(`generate_env_config "KEY=val=ue=extra"`);

    expect(result.exitCode).toBe(0);
    // The key should be KEY and value should be val=ue=extra
    expect(result.stdout).toContain("export KEY='val=ue=extra'");
  });

  it("should handle values containing double quotes", () => {
    const result = runBash(`generate_env_config 'KEY=say "hello"'`);

    expect(result.exitCode).toBe(0);
    // Double quotes inside single-quoted values are literal
    expect(result.stdout).toContain('export KEY=\'say "hello"\'');
  });

  it("should handle values containing backslashes", () => {
    const result = runBash(`generate_env_config 'KEY=path\\\\to\\\\file'`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KEY=");
  });

  it("should handle multiple env pairs", () => {
    const result = runBash(`generate_env_config "A=1" "B=2" "C=3"`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export A='1'");
    expect(result.stdout).toContain("export B='2'");
    expect(result.stdout).toContain("export C='3'");
  });

  it("should produce sourceable output", () => {
    // The generated env config should be sourceable by bash without errors
    const result = runBash(`
      config=$(generate_env_config "MY_KEY=test-value-123" "OTHER=https://example.com/path")
      eval "\${config}"
      echo "MY_KEY=\${MY_KEY}"
      echo "OTHER=\${OTHER}"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MY_KEY=test-value-123");
    expect(result.stdout).toContain("OTHER=https://example.com/path");
  });

  it("should include spawn:env marker comment", () => {
    const result = runBash(`generate_env_config "X=1"`);

    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should handle URL values with special characters", () => {
    const result = runBash(`
      config=$(generate_env_config "URL=https://api.example.com/v1?key=abc&token=xyz")
      eval "\${config}"
      echo "URL=\${URL}"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("URL=https://api.example.com/v1?key=abc&token=xyz");
  });
});
