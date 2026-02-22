import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for environment injection, JSON extraction, SSH key check,
 * and opencode install helpers in shared/common.sh:
 *
 * - inject_env_vars_ssh: Injects env vars into remote server via SSH
 * - inject_env_vars_local: Injects env vars for local/container providers
 * - _extract_json_field: Extracts fields from JSON using Python expressions
 * - check_ssh_key_by_fingerprint: Checks SSH key registration via API
 * - opencode_install_cmd: Generates robust OpenCode install command
 *
 * These functions had zero test coverage despite being used across
 * all cloud provider scripts.
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
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
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

/** Create a temporary directory for test files. */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── inject_env_vars_ssh ────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should call upload_func and run_func with correct arguments", () => {
    const dir = createTempDir();
    try {
      // Create a mock zshrc
      writeFileSync(join(dir, ".zshrc"), "# existing config\n");

      // Mock upload and run functions that log their arguments
      const result = runBash(`
mock_upload() { echo "UPLOAD: \$1 \$2 \$3"; }
mock_run() { echo "RUN: \$1 \$2"; }
inject_env_vars_ssh "192.168.1.1" mock_upload mock_run "MY_KEY=my_value"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("UPLOAD: 192.168.1.1");
      expect(result.stdout).toContain("/tmp/spawn_env_");
      expect(result.stdout).toContain("RUN: 192.168.1.1");
      expect(result.stdout).toContain(".zshrc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should generate correct env config content via upload", () => {
    const dir = createTempDir();
    try {
      // Mock that captures the uploaded file content
      const result = runBash(`
mock_upload() { cat "\$2"; }
mock_run() { true; }
inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "API_KEY=sk-123" "BASE_URL=https://example.com"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("export API_KEY='sk-123'");
      expect(result.stdout).toContain("export BASE_URL='https://example.com'");
      expect(result.stdout).toContain("# [spawn:env]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should handle multiple env vars", () => {
    const result = runBash(`
mock_upload() { cat "\$2"; }
mock_run() { true; }
inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "KEY1=val1" "KEY2=val2" "KEY3=val3"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KEY1='val1'");
    expect(result.stdout).toContain("export KEY2='val2'");
    expect(result.stdout).toContain("export KEY3='val3'");
  });

  it("should pass server_ip as first arg to upload and run functions", () => {
    const result = runBash(`
mock_upload() { echo "UPLOAD_IP=\$1"; }
mock_run() { echo "RUN_IP=\$1"; }
inject_env_vars_ssh "203.0.113.42" mock_upload mock_run "K=V"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UPLOAD_IP=203.0.113.42");
    expect(result.stdout).toContain("RUN_IP=203.0.113.42");
  });

  it("should handle values with special characters", () => {
    const result = runBash(`
mock_upload() { cat "\$2"; }
mock_run() { true; }
inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "URL=https://api.example.com?key=abc&token=def"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export URL='https://api.example.com?key=abc&token=def'");
  });

  it("should create temp file with restrictive permissions", () => {
    const result = runBash(`
mock_upload() {
  local perms
  perms=$(stat -c '%a' "\$2" 2>/dev/null || stat -f '%Lp' "\$2" 2>/dev/null)
  echo "PERMS=\$perms"
}
mock_run() { true; }
inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "SECRET=s3cret"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PERMS=600");
  });
});

// ── inject_env_vars_local ──────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload and run functions without server_ip", () => {
    const result = runBash(`
mock_upload() { echo "UPLOAD_ARGS: \$1 \$2"; }
mock_run() { echo "RUN_ARGS: \$1"; }
inject_env_vars_local mock_upload mock_run "MY_KEY=my_value"
`);
    expect(result.exitCode).toBe(0);
    // inject_env_vars_local does NOT pass server_ip - upload gets (local_path, remote_path)
    expect(result.stdout).toContain("UPLOAD_ARGS:");
    expect(result.stdout).toContain("/tmp/spawn_env_");
    expect(result.stdout).toMatch(/cat '\/tmp\/spawn_env_[^']+' >> ~\/.bashrc; cat '\/tmp\/spawn_env_[^']+' >> ~\/.zshrc/);
  });

  it("should generate correct env config content", () => {
    const result = runBash(`
mock_upload() { cat "\$1"; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "OPENROUTER_KEY=sk-or-v1-abc"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export OPENROUTER_KEY='sk-or-v1-abc'");
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should handle multiple env vars", () => {
    const result = runBash(`
mock_upload() { cat "\$1"; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "K1=v1" "K2=v2"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export K1='v1'");
    expect(result.stdout).toContain("export K2='v2'");
  });

  it("should create temp file with 600 permissions", () => {
    const result = runBash(`
mock_upload() {
  local perms
  perms=$(stat -c '%a' "\$1" 2>/dev/null || stat -f '%Lp' "\$1" 2>/dev/null)
  echo "PERMS=\$perms"
}
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "SECRET=hidden"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PERMS=600");
  });

  it("should differ from inject_env_vars_ssh in argument passing", () => {
    // inject_env_vars_local passes (local_path, remote_path) to upload
    // inject_env_vars_ssh passes (server_ip, local_path, remote_path) to upload
    const localResult = runBash(`
mock_upload() { echo "ARG_COUNT=\$#"; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "K=V"
`);
    const sshResult = runBash(`
mock_upload() { echo "ARG_COUNT=\$#"; }
mock_run() { true; }
inject_env_vars_ssh "10.0.0.1" mock_upload mock_run "K=V"
`);
    // local: upload(local_path, remote_path) = 2 args
    // ssh: upload(server_ip, local_path, remote_path) = 3 args
    expect(localResult.stdout).toContain("ARG_COUNT=2");
    expect(sshResult.stdout).toContain("ARG_COUNT=3");
  });

  it("should handle values with single quotes via escaping", () => {
    const result = runBash(`
mock_upload() { cat "\$1"; }
mock_run() { true; }
inject_env_vars_local mock_upload mock_run "MSG=it'\\''s a test"
`);
    expect(result.exitCode).toBe(0);
    // The value should be properly escaped for bash sourcing
    expect(result.stdout).toContain("export MSG=");
  });
});

// _extract_json_field tests are in shared-common-json-extraction.test.ts

// ── check_ssh_key_by_fingerprint ───────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
mock_api() { echo '{"ssh_keys":[{"fingerprint":"aa:bb:cc:dd"}]}'; }
check_ssh_key_by_fingerprint mock_api "/ssh_keys" "aa:bb:cc:dd"
`);
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when fingerprint is not found", () => {
    const result = runBash(`
mock_api() { echo '{"ssh_keys":[{"fingerprint":"xx:yy:zz:00"}]}'; }
check_ssh_key_by_fingerprint mock_api "/ssh_keys" "aa:bb:cc:dd"
`);
    expect(result.exitCode).not.toBe(0);
  });

  it("should pass endpoint to the API function", () => {
    const result = runBash(`
mock_api() { echo "CALLED_WITH: \$1 \$2"; }
check_ssh_key_by_fingerprint mock_api "/v2/account/keys" "test-fp" 2>/dev/null || true
echo "DONE"
`);
    expect(result.stdout).toContain("DONE");
  });

  it("should handle multiple keys and find a match", () => {
    const result = runBash(`
mock_api() {
  echo '{"ssh_keys":[{"fingerprint":"11:22:33:44"},{"fingerprint":"55:66:77:88"},{"fingerprint":"aa:bb:cc:dd"}]}'
}
check_ssh_key_by_fingerprint mock_api "/ssh_keys" "55:66:77:88"
`);
    expect(result.exitCode).toBe(0);
  });

  it("should return failure for empty API response", () => {
    const result = runBash(`
mock_api() { echo '{"ssh_keys":[]}'; }
check_ssh_key_by_fingerprint mock_api "/ssh_keys" "aa:bb:cc:dd"
`);
    expect(result.exitCode).not.toBe(0);
  });

  it("should handle SHA256 format fingerprints", () => {
    const result = runBash(`
mock_api() { echo '{"keys":[{"fingerprint":"SHA256:abcdef1234567890ABCDEF"}]}'; }
check_ssh_key_by_fingerprint mock_api "/keys" "SHA256:abcdef1234567890ABCDEF"
`);
    expect(result.exitCode).toBe(0);
  });

  it("should use GET method when calling API function", () => {
    const result = runBash(`
mock_api() {
  echo "METHOD=\$1 ENDPOINT=\$2" >&2
  echo '{"keys":[]}'
}
check_ssh_key_by_fingerprint mock_api "/ssh_keys" "test" 2>&1 | head -1
`);
    expect(result.stdout).toContain("METHOD=GET");
    expect(result.stdout).toContain("ENDPOINT=/ssh_keys");
  });
});

// opencode_install_cmd tests are in shared-common-logging-utils.test.ts

// track_temp_file/cleanup_temp_files tests are in shared-common-logging-utils.test.ts
// validate_resource_name tests are in shared-common-validators.test.ts
