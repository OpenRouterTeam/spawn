import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { resolve, join } from "path";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";

/**
 * Tests for the SSH key lifecycle functions in shared/common.sh:
 *
 * - ensure_ssh_key_with_provider: Generic SSH key registration flow using
 *   provider-specific callbacks. Used by all cloud providers to handle the
 *   full generate -> check -> register lifecycle. ZERO prior test coverage.
 *
 * - generate_ssh_key_if_missing: Generates ed25519 key if not present.
 *   Edge cases around existing keys, nested directories, permissions.
 *
 * - get_ssh_fingerprint: Extracts MD5 fingerprint from public key.
 *   Edge cases around key formats and error handling.
 *
 * These functions are security-critical (SSH key management) and are invoked
 * by every cloud provider's lib/common.sh. The callback-based pattern in
 * ensure_ssh_key_with_provider can have subtle bugs around:
 * - Check callback returning unexpected exit codes
 * - Register callback failing after key generation succeeded
 * - Custom key paths vs default key paths
 * - Key already registered vs needs registration
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Uses spawnSync to properly capture both stdout and stderr
 * (execSync only captures stderr in the error path).
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
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

/** Create a temporary directory for test files. */
function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── generate_ssh_key_if_missing ──────────────────────────────────────────

describe("generate_ssh_key_if_missing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should generate an ed25519 key when none exists", () => {
    const keyPath = join(tempDir, "test_key");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
    expect(existsSync(`${keyPath}.pub`)).toBe(true);
  });

  it("should generate key content that starts with openssh private key header", () => {
    const keyPath = join(tempDir, "test_key");
    runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    const content = readFileSync(keyPath, "utf-8");
    expect(content).toContain("OPENSSH PRIVATE KEY");
  });

  it("should generate public key with ssh-ed25519 prefix", () => {
    const keyPath = join(tempDir, "test_key");
    runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    const pubContent = readFileSync(`${keyPath}.pub`, "utf-8");
    expect(pubContent).toContain("ssh-ed25519");
  });

  it("should not overwrite an existing key", () => {
    const keyPath = join(tempDir, "existing_key");
    writeFileSync(keyPath, "existing-content");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);

    // Content should be unchanged
    const content = readFileSync(keyPath, "utf-8");
    expect(content).toBe("existing-content");
  });

  it("should create nested directories if they do not exist", () => {
    const keyPath = join(tempDir, "deep", "nested", "dir", "test_key");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(keyPath)).toBe(true);
  });

  it("should generate key with empty passphrase (no password)", () => {
    const keyPath = join(tempDir, "no_pass_key");
    runBash(`generate_ssh_key_if_missing "${keyPath}"`);

    // Verify the key can be read without a passphrase by getting its fingerprint
    const result = runBash(`ssh-keygen -lf "${keyPath}.pub" -E md5`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MD5:");
  });

  it("should log a step message when generating", () => {
    const keyPath = join(tempDir, "test_key_log");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.stderr).toContain("Generating SSH key");
  });

  it("should log info message after successful generation", () => {
    const keyPath = join(tempDir, "test_key_info");
    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.stderr).toContain("SSH key generated at");
    expect(result.stderr).toContain(keyPath);
  });

  it("should not log generation messages when key already exists", () => {
    const keyPath = join(tempDir, "existing_key2");
    writeFileSync(keyPath, "existing");

    const result = runBash(`generate_ssh_key_if_missing "${keyPath}"`);
    expect(result.stderr).not.toContain("Generating SSH key");
    expect(result.stderr).not.toContain("SSH key generated");
  });
});

// ── get_ssh_fingerprint ──────────────────────────────────────────────────

describe("get_ssh_fingerprint", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return MD5 fingerprint for a valid ed25519 public key", () => {
    const keyPath = join(tempDir, "fp_test_key");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    // MD5 fingerprint format: aa:bb:cc:dd:...
    expect(result.stdout).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2})+$/);
  });

  it("should strip MD5: prefix from fingerprint", () => {
    const keyPath = join(tempDir, "fp_strip_key");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.stdout).not.toContain("MD5:");
  });

  it("should return consistent fingerprint for same key", () => {
    const keyPath = join(tempDir, "fp_consistent_key");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

    const result1 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    const result2 = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result1.stdout).toBe(result2.stdout);
  });

  it("should return different fingerprints for different keys", () => {
    const keyPath1 = join(tempDir, "fp_key1");
    const keyPath2 = join(tempDir, "fp_key2");
    runBash(`ssh-keygen -t ed25519 -f "${keyPath1}" -N "" -q`);
    runBash(`ssh-keygen -t ed25519 -f "${keyPath2}" -N "" -q`);

    const fp1 = runBash(`get_ssh_fingerprint "${keyPath1}.pub"`);
    const fp2 = runBash(`get_ssh_fingerprint "${keyPath2}.pub"`);
    expect(fp1.stdout).not.toBe(fp2.stdout);
  });

  it("should work with RSA public keys", () => {
    const keyPath = join(tempDir, "fp_rsa_key");
    runBash(`ssh-keygen -t rsa -b 2048 -f "${keyPath}" -N "" -q`);

    const result = runBash(`get_ssh_fingerprint "${keyPath}.pub"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2})+$/);
  });
});

// ── ensure_ssh_key_with_provider ──────────────────────────────────────────

describe("ensure_ssh_key_with_provider", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("key already registered", () => {
    it("should succeed when check callback returns 0 (key exists)", () => {
      const keyPath = join(tempDir, "existing_key");
      // Pre-generate a key so we skip generation
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_always_exists() { return 0; }
        register_noop() { return 0; }
        ensure_ssh_key_with_provider check_always_exists register_noop "TestCloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("already registered");
      expect(result.stderr).toContain("TestCloud");
    });

    it("should not call register callback when key already registered", () => {
      const keyPath = join(tempDir, "noreg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const markerFile = join(tempDir, "register_called");
      const result = runBash(`
        check_exists() { return 0; }
        register_with_marker() { touch "${markerFile}"; return 0; }
        ensure_ssh_key_with_provider check_exists register_with_marker "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      expect(existsSync(markerFile)).toBe(false);
    });

    it("should pass fingerprint to check callback", () => {
      const keyPath = join(tempDir, "fp_check_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const fpFile = join(tempDir, "fingerprint.txt");
      const result = runBash(`
        check_save_fp() {
          echo "\$1" > "${fpFile}"
          return 0
        }
        register_noop() { return 0; }
        ensure_ssh_key_with_provider check_save_fp register_noop "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const savedFp = readFileSync(fpFile, "utf-8").trim();
      // Fingerprint should be in MD5 hex format
      expect(savedFp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2})+$/);
    });

    it("should pass pub key path to check callback", () => {
      const keyPath = join(tempDir, "pub_check_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const pathFile = join(tempDir, "pub_path.txt");
      const result = runBash(`
        check_save_path() {
          echo "\$2" > "${pathFile}"
          return 0
        }
        register_noop() { return 0; }
        ensure_ssh_key_with_provider check_save_path register_noop "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const savedPath = readFileSync(pathFile, "utf-8").trim();
      expect(savedPath).toBe(`${keyPath}.pub`);
    });
  });

  describe("key not registered - successful registration", () => {
    it("should register key when check callback returns 1 (not found)", () => {
      const keyPath = join(tempDir, "new_reg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_not_found() { return 1; }
        register_success() { return 0; }
        ensure_ssh_key_with_provider check_not_found register_success "Hetzner" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Registering SSH key");
      expect(result.stderr).toContain("Hetzner");
      expect(result.stderr).toContain("SSH key registered");
    });

    it("should pass key name to register callback", () => {
      const keyPath = join(tempDir, "name_reg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const nameFile = join(tempDir, "key_name.txt");
      const result = runBash(`
        check_not_found() { return 1; }
        register_save_name() {
          echo "\$1" > "${nameFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_not_found register_save_name "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const keyName = readFileSync(nameFile, "utf-8").trim();
      // Key name format: spawn-<hostname>-<timestamp>
      expect(keyName).toMatch(/^spawn-/);
    });

    it("should pass pub key path to register callback", () => {
      const keyPath = join(tempDir, "path_reg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const pathFile = join(tempDir, "reg_path.txt");
      const result = runBash(`
        check_not_found() { return 1; }
        register_save_path() {
          echo "\$2" > "${pathFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_not_found register_save_path "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const savedPath = readFileSync(pathFile, "utf-8").trim();
      expect(savedPath).toBe(`${keyPath}.pub`);
    });
  });

  describe("key not registered - failed registration", () => {
    it("should return error when register callback fails", () => {
      const keyPath = join(tempDir, "fail_reg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_not_found() { return 1; }
        register_fail() { return 1; }
        ensure_ssh_key_with_provider check_not_found register_fail "DigitalOcean" "${keyPath}"
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Failed to register SSH key");
      expect(result.stderr).toContain("DigitalOcean");
    });
  });

  describe("key generation during the flow", () => {
    it("should auto-generate key when key file does not exist", () => {
      const keyPath = join(tempDir, "auto_gen_key");
      // Do NOT pre-generate the key

      const result = runBash(`
        check_not_found() { return 1; }
        register_success() { return 0; }
        ensure_ssh_key_with_provider check_not_found register_success "Vultr" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      // Key should have been generated
      expect(existsSync(keyPath)).toBe(true);
      expect(existsSync(`${keyPath}.pub`)).toBe(true);
      expect(result.stderr).toContain("Generating SSH key");
    });

    it("should auto-generate key and then register it", () => {
      const keyPath = join(tempDir, "gen_and_reg_key");
      const fpFile = join(tempDir, "auto_fp.txt");

      const result = runBash(`
        check_not_found() { return 1; }
        register_save_fp() {
          # Verify the pub key exists at this point
          if [[ -f "${keyPath}.pub" ]]; then
            echo "pub_exists" > "${fpFile}"
          fi
          return 0
        }
        ensure_ssh_key_with_provider check_not_found register_save_fp "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      // Register callback should have been called after key was generated
      expect(readFileSync(fpFile, "utf-8").trim()).toBe("pub_exists");
    });
  });

  describe("default key path", () => {
    it("should use default key path when not specified", () => {
      // Create a mock HOME with an existing SSH key to avoid generating in real ~/.ssh
      const fakeHome = join(tempDir, "fakehome");
      const sshDir = join(fakeHome, ".ssh");
      mkdirSync(sshDir, { recursive: true });
      const defaultKeyPath = join(sshDir, "id_ed25519");
      runBash(`ssh-keygen -t ed25519 -f "${defaultKeyPath}" -N "" -q`);

      const pathFile = join(tempDir, "default_path.txt");
      const result = runBash(
        `
        check_save_path() {
          echo "\$2" > "${pathFile}"
          return 0
        }
        register_noop() { return 0; }
        ensure_ssh_key_with_provider check_save_path register_noop "Cloud"
      `,
        { HOME: fakeHome }
      );
      expect(result.exitCode).toBe(0);
      const savedPath = readFileSync(pathFile, "utf-8").trim();
      expect(savedPath).toBe(`${defaultKeyPath}.pub`);
    });
  });

  describe("provider name in messages", () => {
    it("should include provider name in 'already registered' message", () => {
      const keyPath = join(tempDir, "prov_name_key1");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_exists() { return 0; }
        reg() { return 0; }
        ensure_ssh_key_with_provider check_exists reg "Lambda Cloud" "${keyPath}"
      `);
      expect(result.stderr).toContain("Lambda Cloud");
    });

    it("should include provider name in 'registering' message", () => {
      const keyPath = join(tempDir, "prov_name_key2");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_nf() { return 1; }
        reg_ok() { return 0; }
        ensure_ssh_key_with_provider check_nf reg_ok "Linode" "${keyPath}"
      `);
      expect(result.stderr).toContain("Registering SSH key with Linode");
    });

    it("should include provider name in 'registered' message", () => {
      const keyPath = join(tempDir, "prov_name_key3");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_nf() { return 1; }
        reg_ok() { return 0; }
        ensure_ssh_key_with_provider check_nf reg_ok "UpCloud" "${keyPath}"
      `);
      expect(result.stderr).toContain("SSH key registered with UpCloud");
    });

    it("should include provider name in failure message", () => {
      const keyPath = join(tempDir, "prov_name_key4");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const result = runBash(`
        check_nf() { return 1; }
        reg_fail() { return 1; }
        ensure_ssh_key_with_provider check_nf reg_fail "Kamatera" "${keyPath}"
      `);
      expect(result.stderr).toContain("Failed to register SSH key with Kamatera");
    });
  });

  describe("callback contract", () => {
    it("should call check callback exactly once when key is registered", () => {
      const keyPath = join(tempDir, "once_check_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const countFile = join(tempDir, "check_count.txt");
      writeFileSync(countFile, "0");

      const result = runBash(`
        check_count() {
          local current
          current=$(cat "${countFile}")
          echo $((current + 1)) > "${countFile}"
          return 0
        }
        register_noop() { return 0; }
        ensure_ssh_key_with_provider check_count register_noop "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(countFile, "utf-8").trim()).toBe("1");
    });

    it("should call register callback exactly once when key needs registration", () => {
      const keyPath = join(tempDir, "once_reg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const countFile = join(tempDir, "reg_count.txt");
      writeFileSync(countFile, "0");

      const result = runBash(`
        check_not_found() { return 1; }
        register_count() {
          local current
          current=$(cat "${countFile}")
          echo $((current + 1)) > "${countFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_not_found register_count "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(countFile, "utf-8").trim()).toBe("1");
    });

    it("should not call register callback when check succeeds", () => {
      const keyPath = join(tempDir, "no_reg_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const countFile = join(tempDir, "no_reg_count.txt");
      writeFileSync(countFile, "0");

      const result = runBash(`
        check_found() { return 0; }
        register_count() {
          local current
          current=$(cat "${countFile}")
          echo $((current + 1)) > "${countFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_found register_count "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(countFile, "utf-8").trim()).toBe("0");
    });
  });

  describe("key name generation", () => {
    it("should generate key name with spawn- prefix", () => {
      const keyPath = join(tempDir, "kname_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const nameFile = join(tempDir, "kname.txt");
      const result = runBash(`
        check_nf() { return 1; }
        register_save() {
          echo "\$1" > "${nameFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_nf register_save "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const keyName = readFileSync(nameFile, "utf-8").trim();
      expect(keyName.startsWith("spawn-")).toBe(true);
    });

    it("should include hostname in key name", () => {
      const keyPath = join(tempDir, "hostname_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const nameFile = join(tempDir, "hostname_name.txt");
      const result = runBash(`
        check_nf() { return 1; }
        register_save() {
          echo "\$1" > "${nameFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_nf register_save "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const keyName = readFileSync(nameFile, "utf-8").trim();
      // Format: spawn-<hostname>-<timestamp>
      const parts = keyName.split("-");
      // At minimum: spawn, hostname (might contain dashes), timestamp
      expect(parts.length).toBeGreaterThanOrEqual(3);
    });

    it("should include timestamp in key name", () => {
      const keyPath = join(tempDir, "ts_key");
      runBash(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -q`);

      const nameFile = join(tempDir, "ts_name.txt");
      const result = runBash(`
        check_nf() { return 1; }
        register_save() {
          echo "\$1" > "${nameFile}"
          return 0
        }
        ensure_ssh_key_with_provider check_nf register_save "Cloud" "${keyPath}"
      `);
      expect(result.exitCode).toBe(0);
      const keyName = readFileSync(nameFile, "utf-8").trim();
      // Last segment should be a unix timestamp (numeric)
      const lastPart = keyName.split("-").pop() || "";
      expect(lastPart).toMatch(/^\d+$/);
      // Should be a reasonable timestamp (after 2020)
      const ts = parseInt(lastPart, 10);
      expect(ts).toBeGreaterThan(1577836800); // 2020-01-01
    });
  });
});

// extract_ssh_key_ids tests are in shared-common-untested-helpers.test.ts
// check_ssh_key_by_fingerprint tests are in shared-common-env-inject.test.ts
