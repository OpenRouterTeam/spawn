import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { readFileSync, existsSync, readdirSync } from "fs";

/**
 * Tests for cloud lib/common.sh source chain integrity.
 *
 * Every cloud provider's lib/common.sh must:
 * 1. Source shared/common.sh (directly or via eval fallback)
 * 2. After sourcing, expose the critical shared functions used by agent scripts
 * 3. Not produce errors during sourcing
 * 4. Define the cloud-specific functions required by agent scripts
 *
 * This tests the REAL bash source chain by running each cloud's lib/common.sh
 * in a subprocess and verifying that key functions are defined. A broken source
 * chain would cause ALL agent deployments on that cloud to fail silently.
 *
 * Coverage gap addressed: cloud-lib-api-surface.test.ts checks static patterns
 * in the source code (grep for function names), but never actually sources the
 * files to verify they load without errors and functions are callable. This test
 * catches syntax errors, missing dependencies, and broken source paths.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SHARED_COMMON = resolve(REPO_ROOT, "shared/common.sh");

// Discover all cloud directories that have lib/common.sh
function discoverCloudLibs(): string[] {
  const clouds: string[] = [];
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Skip non-cloud directories
    if (["cli", "shared", "test", "node_modules", ".git", ".github", ".claude", ".docs"].includes(entry.name)) continue;
    const libPath = join(REPO_ROOT, entry.name, "lib", "common.sh");
    if (existsSync(libPath)) {
      clouds.push(entry.name);
    }
  }
  return clouds.sort();
}

const allClouds = discoverCloudLibs();

// Shared functions that EVERY cloud's lib/common.sh must expose after sourcing
const REQUIRED_SHARED_FUNCTIONS = [
  "log_info",
  "log_warn",
  "log_error",
  "log_step",
  "json_escape",
  "generate_ssh_key_if_missing",
  "generic_ssh_wait",
  "validate_api_token",
  "validate_server_name",
  "get_openrouter_api_key_oauth",
  "try_oauth_flow",
  "inject_env_vars_ssh",
  "generic_cloud_api",
  "extract_api_error_message",
  "generic_wait_for_instance",
  "verify_agent_installed",
];

/**
 * Source a cloud's lib/common.sh and check if a function is defined.
 * Uses `declare -F` to test function existence without invoking it.
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
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

// ── Shared prerequisite ─────────────────────────────────────────────────────

describe("shared/common.sh prerequisite", () => {
  it("should exist on disk", () => {
    expect(existsSync(SHARED_COMMON)).toBe(true);
  });

  it("should source without errors", () => {
    const result = runBash(`source "${SHARED_COMMON}"`);
    expect(result.exitCode).toBe(0);
  });

  it("should define all required shared functions", () => {
    const funcChecks = REQUIRED_SHARED_FUNCTIONS
      .map(fn => `declare -F ${fn} > /dev/null || echo "MISSING: ${fn}"`)
      .join("\n");

    const result = runBash(`
      source "${SHARED_COMMON}"
      ${funcChecks}
    `);

    expect(result.exitCode).toBe(0);
    if (result.stdout.includes("MISSING:")) {
      throw new Error(
        `shared/common.sh is missing expected functions:\n${result.stdout}`
      );
    }
  });
});

// ── Cloud lib source chain ──────────────────────────────────────────────────

describe("Cloud lib/common.sh source chain", () => {
  it(`should discover at least 7 cloud lib files`, () => {
    // Note: TS-based clouds (e.g. fly) don't have bash lib/common.sh
    expect(allClouds.length).toBeGreaterThanOrEqual(7);
  });

  for (const cloud of allClouds) {
    const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");

    describe(`${cloud}/lib/common.sh`, () => {
      it("should source without bash errors", () => {
        const result = runBash(`source "${libPath}"`);
        if (result.exitCode !== 0) {
          throw new Error(
            `${cloud}/lib/common.sh failed to source (exit ${result.exitCode}):\n` +
            `stderr: ${result.stderr}`
          );
        }
      });

      it("should expose shared logging functions (log_info, log_warn, log_error)", () => {
        const result = runBash(`
          source "${libPath}"
          declare -F log_info > /dev/null && echo "ok:log_info"
          declare -F log_warn > /dev/null && echo "ok:log_warn"
          declare -F log_error > /dev/null && echo "ok:log_error"
        `);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ok:log_info");
        expect(result.stdout).toContain("ok:log_warn");
        expect(result.stdout).toContain("ok:log_error");
      });

      it("should expose json_escape (security-critical for API calls)", () => {
        const result = runBash(`
          source "${libPath}"
          declare -F json_escape > /dev/null && echo "ok"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ok");
      });

      it("should expose OAuth/API key functions", () => {
        const result = runBash(`
          source "${libPath}"
          declare -F try_oauth_flow > /dev/null && echo "ok:oauth"
          declare -F get_openrouter_api_key_oauth > /dev/null && echo "ok:apikey"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ok:oauth");
        expect(result.stdout).toContain("ok:apikey");
      });

      it("should expose extract_api_error_message (error handling)", () => {
        const result = runBash(`
          source "${libPath}"
          declare -F extract_api_error_message > /dev/null && echo "ok"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ok");
      });

      it("should expose inject_env_vars functions", () => {
        const result = runBash(`
          source "${libPath}"
          HAS_SSH=$(declare -F inject_env_vars_ssh > /dev/null && echo "1" || echo "0")
          HAS_LOCAL=$(declare -F inject_env_vars_local > /dev/null && echo "1" || echo "0")
          if [[ "$HAS_SSH" == "1" ]] || [[ "$HAS_LOCAL" == "1" ]]; then
            echo "ok"
          else
            echo "MISSING: neither inject_env_vars_ssh nor inject_env_vars_local"
          fi
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ok");
      });

      it("should have json_escape that correctly escapes double quotes", () => {
        const result = runBash(`
          source "${libPath}"
          ESCAPED=$(json_escape 'hello "world"')
          echo "$ESCAPED"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('\\"world\\"');
      });

      it("should have log_step defined (cyan progress logging)", () => {
        const result = runBash(`
          source "${libPath}"
          declare -F log_step > /dev/null && echo "ok"
        `);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ok");
      });

      it("should pass bash -n syntax check", () => {
        const result = runBash(`bash -n "${libPath}"`);
        if (result.exitCode !== 0) {
          throw new Error(
            `${cloud}/lib/common.sh has syntax errors:\n${result.stderr}`
          );
        }
      });
    });
  }
});

// ── Cross-cloud consistency ──────────────────────────────────────────────────

describe("Cross-cloud consistency checks", () => {
  it("should have consistent SSH_OPTS default across all clouds", () => {
    // SSH_OPTS is set in shared/common.sh and should be available after sourcing
    const cloudsWithoutSSHOpts: string[] = [];

    for (const cloud of allClouds) {
      // Skip non-SSH clouds
      if (["local", "modal", "e2b", "daytona", "codesandbox", "railway", "render", "koyeb", "northflank", "fly"].includes(cloud)) continue;

      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
      const result = runBash(`
        source "${libPath}"
        [[ -n "\${SSH_OPTS:-}" ]] && echo "ok" || echo "missing"
      `);

      if (result.stdout.includes("missing")) {
        cloudsWithoutSSHOpts.push(cloud);
      }
    }

    if (cloudsWithoutSSHOpts.length > 0) {
      throw new Error(
        `SSH-based clouds missing SSH_OPTS after sourcing:\n` +
        cloudsWithoutSSHOpts.map(c => `  - ${c}`).join("\n")
      );
    }
  });

  it("should have all shared API helper functions available in SSH-based clouds", () => {
    const apiHelpers = [
      "generic_cloud_api",
      "_parse_api_response",
      "_classify_api_result",
      "_api_should_retry_on_error",
    ];

    const failures: string[] = [];

    for (const cloud of allClouds) {
      // Skip non-API clouds
      if (["local"].includes(cloud)) continue;

      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
      for (const fn of apiHelpers) {
        const result = runBash(`
          source "${libPath}"
          declare -F ${fn} > /dev/null && echo "ok" || echo "missing"
        `);

        if (result.stdout.includes("missing")) {
          failures.push(`${cloud}: missing ${fn}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Cloud libs missing shared API helpers:\n` +
        failures.map(f => `  - ${f}`).join("\n")
      );
    }
  });

  it("should use accept-new for StrictHostKeyChecking (TOFU) in SSH_OPTS", () => {
    // PR #849 upgraded from StrictHostKeyChecking=no to accept-new
    const result = runBash(`
      source "${SHARED_COMMON}"
      echo "$SSH_OPTS"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("StrictHostKeyChecking=accept-new");
    expect(result.stdout).not.toContain("StrictHostKeyChecking=no");
  });
});

// ── Function behavior smoke tests (via random cloud) ─────────────────────────

describe("Shared function behavior (smoke tests)", () => {
  // Pick one cloud with SSH to run behavior tests through
  const sshCloud = allClouds.find(c =>
    !["local", "modal", "e2b", "daytona", "codesandbox", "railway", "render", "koyeb", "northflank", "fly"].includes(c)
  );
  const testLibPath = sshCloud ? join(REPO_ROOT, sshCloud, "lib", "common.sh") : SHARED_COMMON;

  it("json_escape should handle newlines", () => {
    const result = runBash(`
      source "${testLibPath}"
      json_escape "line1
line2"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\n");
  });

  it("json_escape should handle backslashes", () => {
    const result = runBash(`
      source "${testLibPath}"
      json_escape 'path\\\\to\\\\file'
    `);
    expect(result.exitCode).toBe(0);
    // The output should have escaped backslashes
    expect(result.stdout).toContain("\\\\");
  });

  it("json_escape should handle tabs", () => {
    // Use $'...' syntax for the tab character to ensure bash interprets it
    const result = runBash(`
      source "${testLibPath}"
      json_escape $'hello\\tworld'
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\t");
  });

  it("validate_api_token should accept valid tokens", () => {
    const result = runBash(`
      source "${testLibPath}"
      validate_api_token "sk-1234567890abcdef"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("validate_api_token should reject tokens with shell metacharacters", () => {
    const result = runBash(`
      source "${testLibPath}"
      validate_api_token "token; rm -rf /"
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("validate_api_token should reject empty tokens", () => {
    const result = runBash(`
      source "${testLibPath}"
      validate_api_token ""
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("validate_server_name should accept valid names", () => {
    const result = runBash(`
      source "${testLibPath}"
      validate_server_name "my-server-123"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("validate_server_name should reject names with spaces", () => {
    const result = runBash(`
      source "${testLibPath}"
      validate_server_name "my server"
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("validate_server_name should reject names with shell metacharacters", () => {
    const result = runBash(`
      source "${testLibPath}"
      validate_server_name "server; rm -rf /"
    `);
    expect(result.exitCode).not.toBe(0);
  });

  it("calculate_retry_backoff should return a reasonable backoff value", () => {
    const result = runBash(`
      source "${testLibPath}"
      calculate_retry_backoff 5 60
    `);
    expect(result.exitCode).toBe(0);
    const backoff = parseInt(result.stdout, 10);
    // Should be between 1 and 60 (the max)
    expect(backoff).toBeGreaterThanOrEqual(1);
    expect(backoff).toBeLessThanOrEqual(60);
  });

  it("extract_api_error_message should extract from standard error format", () => {
    const result = runBash(`
      source "${testLibPath}"
      extract_api_error_message '{"error":{"message":"rate limit exceeded"}}'
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rate limit exceeded");
  });

  it("extract_api_error_message should use fallback for invalid JSON", () => {
    const result = runBash(`
      source "${testLibPath}"
      extract_api_error_message 'not json at all' 'Custom fallback'
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Custom fallback");
  });
});
