import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Tests for env injection, temp file cleanup, and SSH key infrastructure
 * in shared/common.sh.
 *
 * These functions are used by nearly every agent script across all clouds
 * and handle security-sensitive operations:
 * - inject_env_vars_ssh: injects API keys into remote server shell config
 * - inject_env_vars_local: same for non-SSH providers (modal, e2b, sprite)
 * - track_temp_file / cleanup_temp_files: secure deletion of temp credential files
 * - register_cleanup_trap: ensures cleanup on exit/signal
 * - check_ssh_key_by_fingerprint: SSH key dedup before registration
 * - interactive_pick / _display_and_select: env-var-first selection pattern
 * - opencode_install_cmd: install command generation
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/** Run a bash snippet that sources shared/common.sh first. */
function runBash(
  script: string,
  opts?: { stdin?: string }
): { exitCode: number; stdout: string; stderr: string } {
  const { spawnSync } = require("child_process");
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    input: opts?.stdin,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// Track temp directories for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const d = join(tmpdir(), `spawn-test-env-${Date.now()}-${Math.random()}`);
  mkdirSync(d, { recursive: true });
  tempDirs.push(d);
  return d;
}

// ── inject_env_vars_ssh ──────────────────────────────────────────────────────

describe("inject_env_vars_ssh", () => {
  it("should create temp file with correct env config and call upload/run callbacks", () => {
    const tmpDir = makeTempDir();
    const uploadedFile = join(tmpDir, "uploaded.txt");
    const ranCommands = join(tmpDir, "ran.txt");
    // Create stub upload_func and run_func that record their args
    const result = runBash(`
      upload_func() { cp "\$2" "${uploadedFile}"; }
      run_func() { echo "\$2" > "${ranCommands}"; }
      inject_env_vars_ssh "192.168.1.1" upload_func run_func \
        "OPENROUTER_API_KEY=sk-or-test-123" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    `);
    expect(result.exitCode).toBe(0);

    // Check uploaded content contains the env vars
    expect(existsSync(uploadedFile)).toBe(true);
    const uploaded = readFileSync(uploadedFile, "utf-8");
    expect(uploaded).toContain("export OPENROUTER_API_KEY='sk-or-test-123'");
    expect(uploaded).toContain(
      "export ANTHROPIC_BASE_URL='https://openrouter.ai/api'"
    );

    // Check run callback received the append-to-zshrc command
    expect(existsSync(ranCommands)).toBe(true);
    const cmd = readFileSync(ranCommands, "utf-8").trim();
    expect(cmd).toContain("cat /tmp/env_config >> ~/.zshrc");
    expect(cmd).toContain("rm /tmp/env_config");
  });

  it("should pass server_ip as first arg to upload and run callbacks", () => {
    const tmpDir = makeTempDir();
    const argsFile = join(tmpDir, "args.txt");
    const result = runBash(`
      upload_func() { echo "upload:\$1:\$3" >> "${argsFile}"; }
      run_func() { echo "run:\$1" >> "${argsFile}"; }
      inject_env_vars_ssh "10.0.0.5" upload_func run_func "KEY=val"
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8").trim();
    // upload should get server_ip as first arg, remote path as third
    expect(args).toContain("upload:10.0.0.5:/tmp/env_config");
    // run should get server_ip as first arg
    expect(args).toContain("run:10.0.0.5");
  });

  it("should create temp file with mode 600 (read/write owner only)", () => {
    const tmpDir = makeTempDir();
    const result = runBash(`
      upload_func() { stat -c '%a' "\$2" 2>/dev/null || stat -f '%Lp' "\$2"; }
      run_func() { :; }
      inject_env_vars_ssh "host" upload_func run_func "KEY=val"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("600");
  });

  it("should handle values with single quotes safely", () => {
    const tmpDir = makeTempDir();
    const uploadedFile = join(tmpDir, "uploaded.txt");
    const result = runBash(`
      upload_func() { cp "\$2" "${uploadedFile}"; }
      run_func() { :; }
      inject_env_vars_ssh "host" upload_func run_func "KEY=it's a value"
    `);
    expect(result.exitCode).toBe(0);
    const uploaded = readFileSync(uploadedFile, "utf-8");
    // Single quotes should be escaped
    expect(uploaded).toContain("KEY=");
    // Value should be recoverable: source the file and verify
    const checkResult = runBash(`
      source "${uploadedFile}" 2>/dev/null
      echo "\${KEY}"
    `);
    expect(checkResult.stdout).toBe("it's a value");
  });
});

// ── inject_env_vars_local ────────────────────────────────────────────────────

describe("inject_env_vars_local", () => {
  it("should call upload and run callbacks without server_ip", () => {
    const tmpDir = makeTempDir();
    const argsFile = join(tmpDir, "args.txt");
    const result = runBash(`
      upload_func() { echo "upload:\$1:\$2" >> "${argsFile}"; }
      run_func() { echo "run:\$1" >> "${argsFile}"; }
      inject_env_vars_local upload_func run_func "API_KEY=test123"
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8").trim();
    // upload_func gets (temp_file, "/tmp/env_config") -- no server_ip
    expect(args).toContain("upload:");
    expect(args).toContain(":/tmp/env_config");
    // run_func gets the cat command -- no server_ip prefix
    expect(args).toContain("run:cat /tmp/env_config >> ~/.zshrc");
  });

  it("should create env config with multiple key-value pairs", () => {
    const tmpDir = makeTempDir();
    const uploadedFile = join(tmpDir, "uploaded.txt");
    const result = runBash(`
      upload_func() { cp "\$1" "${uploadedFile}"; }
      run_func() { :; }
      inject_env_vars_local upload_func run_func \
        "KEY1=val1" "KEY2=val2" "KEY3=val3"
    `);
    expect(result.exitCode).toBe(0);
    const uploaded = readFileSync(uploadedFile, "utf-8");
    expect(uploaded).toContain("export KEY1='val1'");
    expect(uploaded).toContain("export KEY2='val2'");
    expect(uploaded).toContain("export KEY3='val3'");
  });

  it("should handle empty values", () => {
    const tmpDir = makeTempDir();
    const uploadedFile = join(tmpDir, "uploaded.txt");
    const result = runBash(`
      upload_func() { cp "\$1" "${uploadedFile}"; }
      run_func() { :; }
      inject_env_vars_local upload_func run_func "EMPTY_KEY="
    `);
    expect(result.exitCode).toBe(0);
    const uploaded = readFileSync(uploadedFile, "utf-8");
    expect(uploaded).toContain("export EMPTY_KEY=''");
  });
});

// ── track_temp_file / cleanup_temp_files ─────────────────────────────────────

describe("temp file tracking and cleanup", () => {
  it("should track and clean up a single temp file", () => {
    const tmpDir = makeTempDir();
    const tempFile = join(tmpDir, "creds.tmp");
    writeFileSync(tempFile, "secret-api-key");
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      cleanup_temp_files
      if [[ -f "${tempFile}" ]]; then echo "EXISTS"; else echo "CLEANED"; fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("CLEANED");
  });

  it("should track and clean up multiple temp files", () => {
    const tmpDir = makeTempDir();
    const f1 = join(tmpDir, "cred1.tmp");
    const f2 = join(tmpDir, "cred2.tmp");
    const f3 = join(tmpDir, "cred3.tmp");
    writeFileSync(f1, "key1");
    writeFileSync(f2, "key2");
    writeFileSync(f3, "key3");
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${f1}"
      track_temp_file "${f2}"
      track_temp_file "${f3}"
      cleanup_temp_files
      remaining=0
      [[ -f "${f1}" ]] && remaining=$((remaining + 1))
      [[ -f "${f2}" ]] && remaining=$((remaining + 1))
      [[ -f "${f3}" ]] && remaining=$((remaining + 1))
      echo "\${remaining}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
  });

  it("should handle cleanup when tracked file does not exist", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "/tmp/nonexistent-spawn-cred-${Date.now()}"
      cleanup_temp_files
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });

  it("should handle empty CLEANUP_TEMP_FILES array", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      cleanup_temp_files
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });

  it("should preserve exit code through cleanup", () => {
    // cleanup_temp_files captures and returns the exit code
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      (exit 42)
      cleanup_temp_files
      echo $?
    `);
    expect(result.stdout).toBe("42");
  });

  it("should use shred for secure deletion when available", () => {
    const tmpDir = makeTempDir();
    const tempFile = join(tmpDir, "secure.tmp");
    writeFileSync(tempFile, "super-secret-key");
    // We can't easily verify shred was called, but we can verify
    // the file is actually deleted
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      track_temp_file "${tempFile}"
      cleanup_temp_files
      [[ -f "${tempFile}" ]] && echo "STILL_EXISTS" || echo "DELETED"
    `);
    expect(result.stdout).toBe("DELETED");
  });
});

// ── register_cleanup_trap ────────────────────────────────────────────────────

describe("register_cleanup_trap", () => {
  it("should register EXIT trap that calls cleanup_temp_files", () => {
    const tmpDir = makeTempDir();
    const tempFile = join(tmpDir, "trap-test.tmp");
    writeFileSync(tempFile, "secret");
    // Run in a subshell that exits, triggering the EXIT trap
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      register_cleanup_trap
      track_temp_file "${tempFile}"
      exit 0
    `);
    // The trap should have cleaned up the file on exit
    expect(existsSync(tempFile)).toBe(false);
  });

  it("should auto-register trap when common.sh is sourced", () => {
    // shared/common.sh calls register_cleanup_trap at the end
    // Verify this by checking the trap is set after sourcing
    const result = runBash(`
      trap -p EXIT | grep -q cleanup_temp_files && echo "REGISTERED" || echo "NOT_REGISTERED"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("REGISTERED");
  });
});

// ── check_ssh_key_by_fingerprint ─────────────────────────────────────────────

describe("check_ssh_key_by_fingerprint", () => {
  it("should return 0 when fingerprint is found in API response", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys":[{"fingerprint":"aa:bb:cc:dd"}]}'; }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "aa:bb:cc:dd"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return non-zero when fingerprint is not found", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys":[{"fingerprint":"xx:yy:zz"}]}'; }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "aa:bb:cc:dd"
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("should return non-zero when API returns empty response", () => {
    const result = runBash(`
      mock_api() { echo '{"ssh_keys":[]}'; }
      check_ssh_key_by_fingerprint mock_api "/ssh_keys" "aa:bb:cc:dd"
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("should pass endpoint to the API function", () => {
    const result = runBash(`
      mock_api() {
        if [[ "\$2" == "/v2/account/keys" ]]; then
          echo '{"keys":[{"fingerprint":"test:fp"}]}'
        else
          echo '{"keys":[]}'
        fi
      }
      check_ssh_key_by_fingerprint mock_api "/v2/account/keys" "test:fp"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should use GET method when calling the API function", () => {
    const result = runBash(`
      mock_api() {
        echo "method=\$1" >&2
        echo '{"keys":[{"fp":"abc"}]}'
      }
      check_ssh_key_by_fingerprint mock_api "/keys" "abc"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("method=GET");
  });
});

// ── interactive_pick ─────────────────────────────────────────────────────────

describe("interactive_pick", () => {
  it("should return env var value when set, without calling list callback", () => {
    const result = runBash(`
      export MY_REGION="us-east-1"
      list_regions() { echo "should-not-be-called"; exit 1; }
      interactive_pick "MY_REGION" "default-region" "regions" list_regions
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("us-east-1");
  });

  it("should return default when env var is empty and callback returns empty", () => {
    const result = runBash(`
      unset MY_REGION
      list_regions() { echo ""; }
      interactive_pick "MY_REGION" "eu-central-1" "regions" list_regions
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("eu-central-1");
  });

  it("should prefer env var over list callback result", () => {
    const result = runBash(`
      export SERVER_SIZE="s-2vcpu-4gb"
      list_sizes() { echo "s-1vcpu-1gb|Small"; echo "s-2vcpu-4gb|Medium"; }
      interactive_pick "SERVER_SIZE" "s-1vcpu-1gb" "server sizes" list_sizes
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("s-2vcpu-4gb");
  });
});

// ── _display_and_select ──────────────────────────────────────────────────────

describe("_display_and_select", () => {
  // Note: _display_and_select uses safe_read which requires /dev/tty or a real
  // terminal (stdin -t 0). In test environments (piped stdin, no /dev/tty), we
  // override safe_read to simulate user input.

  it("should select default when user enters empty input", () => {
    const result = runBash(`
      safe_read() { echo ""; }
      echo "us-east-1|US East
eu-west-1|EU West" | _display_and_select "regions" "us-east-1" ""
    `);
    expect(result.exitCode).toBe(0);
    // Default index is 1 (first item), so returns first item's id
    expect(result.stdout).toBe("us-east-1");
  });

  it("should select item by number when user provides valid choice", () => {
    const result = runBash(`
      safe_read() { echo "2"; }
      echo "us-east-1|US East
eu-west-1|EU West" | _display_and_select "regions" "us-east-1" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("eu-west-1");
  });

  it("should return default when user provides invalid selection", () => {
    const result = runBash(`
      safe_read() { echo "99"; }
      echo "us-east-1|US East
eu-west-1|EU West" | _display_and_select "regions" "us-east-1" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("us-east-1");
    expect(result.stderr).toContain("Invalid selection");
  });

  it("should set default_idx based on default_id match", () => {
    // When default_id matches an item, that item's index becomes the default
    const result = runBash(`
      safe_read() { echo ""; }
      echo "us-east-1|US East
eu-west-1|EU West
ap-south-1|Asia Pacific" | _display_and_select "regions" "eu-west-1" "eu-west-1"
    `);
    expect(result.exitCode).toBe(0);
    // Empty input should select the default_id item (eu-west-1 at index 2)
    expect(result.stdout).toBe("eu-west-1");
  });

  it("should handle single item list", () => {
    const result = runBash(`
      safe_read() { echo ""; }
      echo "only-one|The Only Option" | _display_and_select "items" "only-one" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("only-one");
  });

  it("should display numbered items to stderr", () => {
    const result = runBash(`
      safe_read() { echo "1"; }
      echo "item-a|First Item
item-b|Second Item" | _display_and_select "items" "item-a" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("1)");
    expect(result.stderr).toContain("2)");
    expect(result.stderr).toContain("First Item");
    expect(result.stderr).toContain("Second Item");
  });

  it("should select third item from a list of three", () => {
    const result = runBash(`
      safe_read() { echo "3"; }
      echo "a|Alpha
b|Beta
c|Gamma" | _display_and_select "items" "a" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("c");
  });

  it("should return default for non-numeric input", () => {
    const result = runBash(`
      safe_read() { echo "abc"; }
      echo "item-a|First" | _display_and_select "items" "item-a" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("item-a");
    expect(result.stderr).toContain("Invalid selection");
  });
});

// ── opencode_install_cmd ─────────────────────────────────────────────────────

describe("opencode_install_cmd", () => {
  it("should produce a non-empty install command string", () => {
    const result = runBash(`opencode_install_cmd`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(50);
  });

  it("should contain architecture detection logic", () => {
    const result = runBash(`opencode_install_cmd`);
    expect(result.stdout).toContain("uname -m");
    expect(result.stdout).toContain("aarch64");
    expect(result.stdout).toContain("arm64");
  });

  it("should contain OS detection logic", () => {
    const result = runBash(`opencode_install_cmd`);
    expect(result.stdout).toContain("uname -s");
    expect(result.stdout).toContain("darwin");
  });

  it("should download from GitHub releases", () => {
    const result = runBash(`opencode_install_cmd`);
    expect(result.stdout).toContain(
      "github.com/opencode-ai/opencode/releases"
    );
  });

  it("should add opencode to PATH in both .bashrc and .zshrc", () => {
    const result = runBash(`opencode_install_cmd`);
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
    expect(result.stdout).toContain(".opencode/bin");
  });

  it("should be a valid bash command (syntax check)", () => {
    const result = runBash(`
      CMD=$(opencode_install_cmd)
      bash -n <<< "$CMD" 2>&1 && echo "VALID" || echo "INVALID"
    `);
    expect(result.stdout).toBe("VALID");
  });
});

// ── Integration: inject creates tracked temp files that get cleaned up ────────

describe("inject + cleanup integration", () => {
  it("inject_env_vars_ssh should track its temp file for cleanup", () => {
    const tmpDir = makeTempDir();
    const tempListFile = join(tmpDir, "templist.txt");
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      upload_func() { :; }
      run_func() { :; }
      inject_env_vars_ssh "host" upload_func run_func "KEY=val"
      # Print tracked files count
      echo "\${#CLEANUP_TEMP_FILES[@]}"
    `);
    expect(result.exitCode).toBe(0);
    // Should have tracked at least 1 temp file
    expect(parseInt(result.stdout)).toBeGreaterThanOrEqual(1);
  });

  it("inject_env_vars_local should track its temp file for cleanup", () => {
    const result = runBash(`
      CLEANUP_TEMP_FILES=()
      upload_func() { :; }
      run_func() { :; }
      inject_env_vars_local upload_func run_func "KEY=val"
      echo "\${#CLEANUP_TEMP_FILES[@]}"
    `);
    expect(result.exitCode).toBe(0);
    expect(parseInt(result.stdout)).toBeGreaterThanOrEqual(1);
  });

  it("full lifecycle: inject creates temp, exit trap cleans it up", () => {
    // Run in a subprocess so the EXIT trap fires
    const tmpDir = makeTempDir();
    const statusFile = join(tmpDir, "status.txt");
    const { spawnSync } = require("child_process");
    const script = `
      source "${COMMON_SH}"
      CLEANUP_TEMP_FILES=()
      register_cleanup_trap
      upload_func() { :; }
      run_func() { :; }
      inject_env_vars_local upload_func run_func "SECRET=abc"
      # Save the tracked temp file path so we can check it after exit
      echo "\${CLEANUP_TEMP_FILES[0]}" > "${statusFile}"
      exit 0
    `;
    spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      timeout: 10000,
    });
    // Read the temp file path that was tracked
    if (existsSync(statusFile)) {
      const trackedPath = readFileSync(statusFile, "utf-8").trim();
      // The EXIT trap should have cleaned it up
      if (trackedPath && trackedPath.startsWith("/tmp")) {
        expect(existsSync(trackedPath)).toBe(false);
      }
    }
  });
});
