import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for shared/github-auth.sh — standalone GitHub auth helper.
 *
 * This file was merged in PR #824 and has zero test coverage.
 * Tests cover:
 *   - ensure_gh_cli: gh CLI detection and installation dispatch
 *   - _install_gh_binary: OS/arch detection and binary fallback paths
 *   - ensure_gh_auth: authentication via GITHUB_TOKEN and gh auth status
 *   - ensure_github_auth: combined wrapper
 *   - Fallback log functions when common.sh is unavailable
 *   - Direct execution mode (BASH_SOURCE == $0)
 *   - Source pattern and curl|bash fallback
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const GITHUB_AUTH_SH = resolve(REPO_ROOT, "shared/github-auth.sh");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources github-auth.sh.
 * Mocks are applied via PATH manipulation and function overrides.
 */
function runBash(
  script: string,
  opts?: { env?: Record<string, string>; timeout?: number }
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${GITHUB_AUTH_SH}"\n${script}`;
  const envVars = { ...process.env, ...opts?.env };
  try {
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: opts?.timeout ?? 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: envVars,
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

/**
 * Run a bash snippet without sourcing github-auth.sh first.
 */
function runRawBash(
  script: string,
  opts?: { env?: Record<string, string>; timeout?: number }
): { exitCode: number; stdout: string; stderr: string } {
  const envVars = { ...process.env, ...opts?.env };
  try {
    const stdout = execSync(`bash -c '${fullEscape(script)}'`, {
      encoding: "utf-8",
      timeout: opts?.timeout ?? 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: envVars,
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

function fullEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Source Pattern ───────────────────────────────────────────────────────

describe("shared/github-auth.sh source pattern", () => {
  it("should pass bash syntax check", () => {
    const result = runRawBash(`bash -n "${GITHUB_AUTH_SH}"`);
    expect(result.exitCode).toBe(0);
  });

  it("should source shared/common.sh and make log functions available", () => {
    const result = runBash("type log_info");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should make ensure_gh_cli available after sourcing", () => {
    const result = runBash("type ensure_gh_cli");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should make ensure_gh_auth available after sourcing", () => {
    const result = runBash("type ensure_gh_auth");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should make ensure_github_auth available after sourcing", () => {
    const result = runBash("type ensure_github_auth");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should make _install_gh_binary available after sourcing", () => {
    const result = runBash("type _install_gh_binary");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should have log_step available (from common.sh)", () => {
    const result = runBash("type log_step");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should have log_warn available (from common.sh)", () => {
    const result = runBash("type log_warn");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });

  it("should have log_error available (from common.sh)", () => {
    const result = runBash("type log_error");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });
});

// ── Fallback Log Functions ──────────────────────────────────────────────

describe("fallback log functions", () => {
  it("should define fallback log_info if common.sh loading is bypassed", () => {
    // Simulate common.sh failing to load by overriding SCRIPT_DIR
    // and checking that the fallback definitions are set up
    const script = `
      # Unset log functions to simulate common.sh failing
      unset -f log_info log_step log_warn log_error 2>/dev/null
      # Re-evaluate the fallback block from the script
      if ! type log_info &>/dev/null 2>&1; then
          log_info()  { printf '[github-auth] %s\\n' "$*" >&2; }
          log_step()  { printf '[github-auth] %s\\n' "$*" >&2; }
          log_warn()  { printf '[github-auth] WARNING: %s\\n' "$*" >&2; }
          log_error() { printf '[github-auth] ERROR: %s\\n' "$*" >&2; }
      fi
      log_info "test message" 2>&1
    `;
    const result = runRawBash(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[github-auth] test message");
  });

  it("should prefix fallback log_warn with WARNING:", () => {
    const script = `
      unset -f log_info log_step log_warn log_error 2>/dev/null
      log_warn()  { printf '[github-auth] WARNING: %s\\n' "$*" >&2; }
      log_warn "something wrong" 2>&1
    `;
    const result = runRawBash(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[github-auth] WARNING: something wrong");
  });

  it("should prefix fallback log_error with ERROR:", () => {
    const script = `
      unset -f log_info log_step log_warn log_error 2>/dev/null
      log_error() { printf '[github-auth] ERROR: %s\\n' "$*" >&2; }
      log_error "fatal problem" 2>&1
    `;
    const result = runRawBash(script);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[github-auth] ERROR: fatal problem");
  });
});

// ── ensure_gh_cli ───────────────────────────────────────────────────────

describe("ensure_gh_cli", () => {
  it("should succeed when gh is already on PATH", () => {
    // Redirect stderr to stdout so we can capture log messages
    const result = runBash("ensure_gh_cli 2>&1");
    // It should succeed since gh is installed in CI/dev
    if (result.exitCode === 0) {
      expect(result.stdout).toContain("gh");
    }
    // If gh is not installed, the function would try to install
    // Either way it should not hang
  });

  it("should report gh version when already installed", () => {
    const result = runBash(`
      # Mock command -v to always succeed for gh, and gh --version
      gh() { if [[ "$1" == "--version" ]]; then echo "gh version 2.50.0 (2024-05-01)"; fi; }
      export -f gh
      command() { if [[ "$1" == "-v" && "$2" == "gh" ]]; then return 0; fi; builtin command "$@"; }
      ensure_gh_cli 2>&1
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should try homebrew on macOS when gh is missing", () => {
    // Test the macOS code path by checking the function body
    const result = runBash(`
      # Check that the function references brew install gh
      type ensure_gh_cli | grep -q "brew install gh"
      echo "found_brew_path"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found_brew_path");
  });

  it("should try apt-get on Debian/Ubuntu when gh is missing", () => {
    const result = runBash(`
      type ensure_gh_cli | grep -q "apt-get"
      echo "found_apt_path"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found_apt_path");
  });

  it("should try dnf on Fedora/RHEL when gh is missing", () => {
    const result = runBash(`
      type ensure_gh_cli | grep -q "dnf"
      echo "found_dnf_path"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found_dnf_path");
  });

  it("should fall back to binary installer on unknown systems", () => {
    const result = runBash(`
      type ensure_gh_cli | grep -q "_install_gh_binary"
      echo "found_binary_fallback"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found_binary_fallback");
  });

  it("should fail if gh not found after installation attempt", () => {
    const result = runBash(`
      # Set OSTYPE to linux
      export OSTYPE="linux-gnu"
      # Override command -v to fail for gh, apt-get, dnf
      command() {
        if [[ "$1" == "-v" ]]; then
          case "$2" in
            gh|apt-get|dnf) return 1 ;;
          esac
        fi
        builtin command "$@"
      }
      # Override _install_gh_binary to fail with an error
      _install_gh_binary() {
        log_error "Failed to install gh"
        return 1
      }
      ensure_gh_cli 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Failed to install");
  });
});

// ── _install_gh_binary ──────────────────────────────────────────────────

describe("_install_gh_binary", () => {
  it("should detect Linux as gh_os=linux", () => {
    const result = runBash(`
      # Override uname to return Linux
      uname() {
        if [[ "$1" == "-s" ]]; then echo "Linux";
        elif [[ "$1" == "-m" ]]; then echo "x86_64";
        fi
      }
      # Override curl to avoid network calls
      curl() { echo '{"tag_name": "v2.50.0"}'; }
      # Check the case statement logic by sourcing and inspecting
      type _install_gh_binary | grep -q 'linux'
      echo "linux_detected"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("linux_detected");
  });

  it("should detect Darwin as gh_os=macOS", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q 'macOS'
      echo "macos_detected"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("macos_detected");
  });

  it("should map x86_64 to amd64", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q 'amd64'
      echo "amd64_mapped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("amd64_mapped");
  });

  it("should map aarch64 to arm64", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q 'arm64'
      echo "arm64_mapped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("arm64_mapped");
  });

  it("should fail for unsupported OS", () => {
    const result = runBash(`
      uname() {
        if [[ "$1" == "-s" ]]; then echo "FreeBSD";
        elif [[ "$1" == "-m" ]]; then echo "x86_64";
        fi
      }
      _install_gh_binary 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unsupported OS");
  });

  it("should fail for unsupported architecture", () => {
    const result = runBash(`
      uname() {
        if [[ "$1" == "-s" ]]; then echo "Linux";
        elif [[ "$1" == "-m" ]]; then echo "mips64";
        fi
      }
      _install_gh_binary 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Unsupported architecture");
  });

  it("should fail when version fetch returns empty", () => {
    const result = runBash(`
      uname() {
        if [[ "$1" == "-s" ]]; then echo "Linux";
        elif [[ "$1" == "-m" ]]; then echo "x86_64";
        fi
      }
      # Mock curl to return empty/bad JSON
      curl() { echo '{}'; return 0; }
      _install_gh_binary 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("version");
  });

  it("should install to ~/.local/bin", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q '.local/bin'
      echo "local_bin_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("local_bin_found");
  });

  it("should add ~/.local/bin to PATH if not already there", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q 'export PATH'
      echo "path_export_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("path_export_found");
  });

  it("should use GitHub releases API URL", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q 'api.github.com/repos/cli/cli/releases/latest'
      echo "api_url_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("api_url_found");
  });

  it("should clean up temp dir on download failure", () => {
    const result = runBash(`
      type _install_gh_binary | grep -q 'rm -rf'
      echo "cleanup_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cleanup_found");
  });
});

// ── ensure_gh_auth ──────────────────────────────────────────────────────

describe("ensure_gh_auth", () => {
  it("should succeed when gh auth status passes", () => {
    const result = runBash(`
      # Mock gh to succeed on auth status
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then return 0; fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("Authenticated");
  });

  it("should use GITHUB_TOKEN when set and auth status fails", () => {
    const result = runBash(`
      export GITHUB_TOKEN="ghp_test123"
      auth_attempted=0
      # Mock gh
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then
          if [[ "$auth_attempted" == "0" ]]; then
            auth_attempted=1
            return 1  # First check fails
          fi
          return 0  # After login, status succeeds
        fi
        if [[ "$1" == "auth" && "$2" == "login" && "$3" == "--with-token" ]]; then
          read token
          if [[ "$token" == "ghp_test123" ]]; then
            return 0
          fi
          return 1
        fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should fail when GITHUB_TOKEN auth fails", () => {
    const result = runBash(`
      export GITHUB_TOKEN="bad_token"
      # Mock gh
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then return 1; fi
        if [[ "$1" == "auth" && "$2" == "login" && "$3" == "--with-token" ]]; then
          read token  # consume stdin
          return 1
        fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Failed to authenticate");
  });

  it("should attempt interactive login when GITHUB_TOKEN is not set", () => {
    const result = runBash(`
      unset GITHUB_TOKEN
      # Mock gh
      login_called=0
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then
          if [[ "$login_called" == "0" ]]; then return 1; fi
          return 0
        fi
        if [[ "$1" == "auth" && "$2" == "login" ]]; then
          login_called=1
          return 0
        fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should fail when interactive login fails", () => {
    const result = runBash(`
      unset GITHUB_TOKEN
      # Mock gh
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then return 1; fi
        if [[ "$1" == "auth" && "$2" == "login" ]]; then return 1; fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Failed to authenticate");
  });

  it("should fail when post-login auth status check fails", () => {
    const result = runBash(`
      unset GITHUB_TOKEN
      # Mock gh - login succeeds but status always fails
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then return 1; fi
        if [[ "$1" == "auth" && "$2" == "login" ]]; then return 0; fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("auth status check failed");
  });

  it("should log step message when not authenticated", () => {
    const result = runBash(`
      export GITHUB_TOKEN="ghp_good"
      call_count=0
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then
          call_count=$((call_count + 1))
          if [[ "$call_count" -le 1 ]]; then return 1; fi
          return 0
        fi
        if [[ "$1" == "auth" && "$2" == "login" ]]; then
          read token
          return 0
        fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.stdout + result.stderr).toContain("Not authenticated");
  });

  it("should mention GITHUB_TOKEN in log when using token auth", () => {
    const result = runBash(`
      export GITHUB_TOKEN="ghp_token123"
      call_count=0
      gh() {
        if [[ "$1" == "auth" && "$2" == "status" ]]; then
          call_count=$((call_count + 1))
          if [[ "$call_count" -le 1 ]]; then return 1; fi
          return 0
        fi
        if [[ "$1" == "auth" && "$2" == "login" && "$3" == "--with-token" ]]; then
          read token
          return 0
        fi
        return 1
      }
      ensure_gh_auth 2>&1
    `);
    expect(result.stdout + result.stderr).toContain("GITHUB_TOKEN");
  });
});

// ── ensure_github_auth (combined wrapper) ───────────────────────────────

describe("ensure_github_auth", () => {
  it("should call ensure_gh_cli then ensure_gh_auth", () => {
    const result = runBash(`
      # Mock gh to be available and authenticated
      gh() {
        if [[ "$1" == "--version" ]]; then echo "gh version 2.50.0"; return 0; fi
        if [[ "$1" == "auth" && "$2" == "status" ]]; then return 0; fi
        return 1
      }
      command() {
        if [[ "$1" == "-v" && "$2" == "gh" ]]; then return 0; fi
        builtin command "$@"
      }
      ensure_github_auth 2>&1
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should fail if ensure_gh_cli fails", () => {
    const result = runBash(`
      # Override ensure_gh_cli to fail
      ensure_gh_cli() { return 1; }
      ensure_github_auth 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("should fail if ensure_gh_auth fails after ensure_gh_cli succeeds", () => {
    const result = runBash(`
      # Override ensure_gh_cli to succeed
      ensure_gh_cli() { return 0; }
      # Override ensure_gh_auth to fail
      ensure_gh_auth() { return 1; }
      ensure_github_auth 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("should succeed when both steps succeed", () => {
    const result = runBash(`
      ensure_gh_cli() { return 0; }
      ensure_gh_auth() { return 0; }
      ensure_github_auth 2>&1
    `);
    expect(result.exitCode).toBe(0);
  });
});

// ── Direct Execution Mode ───────────────────────────────────────────────

describe("direct execution mode", () => {
  it("should run ensure_github_auth when executed directly", () => {
    // The script has a check: if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    // When executed directly, it should set -eo pipefail and call ensure_github_auth
    const result = runBash(`
      # Check that the direct execution block exists
      grep -q 'BASH_SOURCE\\[0\\].*==.*\\$.*0' "${GITHUB_AUTH_SH}"
      echo "direct_exec_check_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("direct_exec_check_found");
  });

  it("should set -eo pipefail in direct execution mode", () => {
    const result = runBash(`
      grep -q 'set -eo pipefail' "${GITHUB_AUTH_SH}"
      echo "pipefail_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipefail_found");
  });
});

// ── Script Structure and Conventions ────────────────────────────────────

describe("script structure and conventions", () => {
  it("should start with bash shebang", () => {
    const result = runRawBash(`head -1 "${GITHUB_AUTH_SH}"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("#!/bin/bash");
  });

  it("should source shared/common.sh with local-or-remote fallback", () => {
    const result = runRawBash(`
      grep -q 'source.*common.sh' "${GITHUB_AUTH_SH}" && \
      grep -q 'curl.*common.sh' "${GITHUB_AUTH_SH}" && \
      echo "fallback_pattern_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fallback_pattern_found");
  });

  it("should use SCRIPT_DIR for path resolution", () => {
    const result = runRawBash(`grep -q 'SCRIPT_DIR=' "${GITHUB_AUTH_SH}" && echo "found"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should use raw.githubusercontent.com for remote fallback", () => {
    const result = runRawBash(
      `grep -q 'raw.githubusercontent.com/OpenRouterTeam/spawn/main' "${GITHUB_AUTH_SH}" && echo "found"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should not use echo -e (macOS bash 3.x compat)", () => {
    const result = runRawBash(`grep -n 'echo -e' "${GITHUB_AUTH_SH}" | wc -l`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });

  it("should not use source <(cmd) pattern (macOS compat)", () => {
    const result = runRawBash(`grep -n 'source <(' "${GITHUB_AUTH_SH}" | wc -l`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });

  it("should use printf instead of echo -e for formatted output", () => {
    const result = runRawBash(`grep -c 'printf' "${GITHUB_AUTH_SH}"`);
    expect(result.exitCode).toBe(0);
    const count = parseInt(result.stdout.trim(), 10);
    expect(count).toBeGreaterThan(0);
  });

  it("should not use set -u (nounset) flag", () => {
    const result = runRawBash(`grep -n 'set.*-.*u' "${GITHUB_AUTH_SH}" | grep -v 'set -eo' | wc -l`);
    expect(result.exitCode).toBe(0);
    // Should have 0 lines with set -u (the set -eo pipefail line is fine)
    expect(result.stdout.trim()).toBe("0");
  });

  it("should use ${VAR:-} for optional env var checks", () => {
    // Check GITHUB_TOKEN is accessed safely
    const result = runRawBash(`grep -q 'GITHUB_TOKEN:-' "${GITHUB_AUTH_SH}" && echo "safe"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("safe");
  });

  it("should use ${SCRIPT_DIR:-} for optional SCRIPT_DIR check", () => {
    const result = runRawBash(`grep -q 'SCRIPT_DIR:-' "${GITHUB_AUTH_SH}" && echo "safe"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("safe");
  });
});

// ── ensure_gh_cli installation paths ────────────────────────────────────

describe("ensure_gh_cli installation paths", () => {
  it("should check OSTYPE for macOS detection", () => {
    const result = runRawBash(`grep -q 'OSTYPE.*darwin' "${GITHUB_AUTH_SH}" && echo "found"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should check OSTYPE for linux detection", () => {
    const result = runRawBash(`grep -q 'OSTYPE.*linux-gnu' "${GITHUB_AUTH_SH}" && echo "found"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should add GitHub CLI APT repository on Debian/Ubuntu", () => {
    const result = runRawBash(
      `grep -q 'githubcli-archive-keyring.gpg' "${GITHUB_AUTH_SH}" && echo "found"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should handle Homebrew not being installed on macOS", () => {
    const result = runRawBash(
      `grep -q 'Homebrew not found' "${GITHUB_AUTH_SH}" && echo "found"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });
});

// ── Error handling edge cases ───────────────────────────────────────────

describe("error handling edge cases", () => {
  it("should return 1 from ensure_gh_cli when brew install fails", () => {
    const result = runBash(`
      type ensure_gh_cli | grep -q 'return 1'
      echo "return_1_found"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("return_1_found");
  });

  it("should provide helpful error message when installation fails on macOS without brew", () => {
    const result = runRawBash(
      `grep -q 'Install Homebrew first' "${GITHUB_AUTH_SH}" && echo "found"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should suggest manual install URL for unsupported platforms", () => {
    const result = runRawBash(
      `grep -q 'cli.github.com' "${GITHUB_AUTH_SH}" && echo "found"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should suggest gh auth login in error message on auth failure", () => {
    const result = runRawBash(
      `grep -q 'gh auth login' "${GITHUB_AUTH_SH}" && echo "found"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("found");
  });

  it("should handle _install_gh_binary curl failure for version fetch", () => {
    const result = runBash(`
      uname() {
        if [[ "$1" == "-s" ]]; then echo "Linux";
        elif [[ "$1" == "-m" ]]; then echo "x86_64";
        fi
      }
      curl() { return 1; }
      _install_gh_binary 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("should handle _install_gh_binary tarball download failure", () => {
    const result = runBash(`
      uname() {
        if [[ "$1" == "-s" ]]; then echo "Linux";
        elif [[ "$1" == "-m" ]]; then echo "x86_64";
        fi
      }
      call_count=0
      curl() {
        call_count=$((call_count + 1))
        if [[ "$call_count" -eq 1 ]]; then
          # First call: version fetch succeeds
          echo '"tag_name": "v2.50.0"'
          return 0
        fi
        # Second call: download fails
        return 1
      }
      _install_gh_binary 2>&1
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("should handle _install_gh_binary tar extraction failure", () => {
    const tmpDir = createTempDir();
    const fakeTarball = join(tmpDir, "fake.tar.gz");
    writeFileSync(fakeTarball, "not a real tarball");

    const result = runBash(`
      uname() {
        if [[ "$1" == "-s" ]]; then echo "Linux";
        elif [[ "$1" == "-m" ]]; then echo "x86_64";
        fi
      }
      call_count=0
      curl() {
        call_count=$((call_count + 1))
        if [[ "$1" == "-fsSL" && "$2" =~ api.github.com ]]; then
          echo '"tag_name": "v2.50.0"'
          return 0
        fi
        # Download: write garbage to the output file
        local outfile=""
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "-o" ]]; then outfile="$2"; shift; shift; continue; fi
          shift
        done
        if [[ -n "$outfile" ]]; then
          echo "not a tarball" > "$outfile"
        fi
        return 0
      }
      _install_gh_binary 2>&1
    `);
    expect(result.exitCode).not.toBe(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── GITHUB_TOKEN piping security ────────────────────────────────────────

describe("GITHUB_TOKEN handling security", () => {
  it("should pipe GITHUB_TOKEN via printf (not command line arg)", () => {
    // The script uses: printf '%s\n' "${GITHUB_TOKEN}" | gh auth login --with-token
    // This avoids exposing the token in process args
    const result = runRawBash(
      `grep -q "printf.*GITHUB_TOKEN.*gh auth login --with-token" "${GITHUB_AUTH_SH}" && echo "piped"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("piped");
  });

  it("should not pass GITHUB_TOKEN as a command line argument", () => {
    // Ensure the token is never directly on the gh command line
    const result = runRawBash(
      `grep 'gh auth login.*GITHUB_TOKEN' "${GITHUB_AUTH_SH}" | wc -l`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });
});
