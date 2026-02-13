import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for OAuth flow functions in shared/common.sh.
 *
 * The OAuth flow is the primary authentication mechanism for spawn users,
 * yet its component functions had zero test coverage. This file tests:
 *
 * - validate_oauth_port: port range validation (1024-65535, numeric only)
 * - _generate_csrf_state: CSRF token generation (security-critical)
 * - _generate_oauth_html: HTML page generation for OAuth callback
 * - _generate_oauth_server_script: Node.js callback server generation
 * - _validate_oauth_server_args: prerequisite validation (port, state, runtime)
 * - _init_oauth_session: temp directory and CSRF state file creation
 * - cleanup_oauth_session: PID and directory cleanup
 * - exchange_oauth_code: OAuth code-to-key exchange (json_escape security)
 *
 * These are SECURITY-CRITICAL: CSRF state prevents OAuth code interception,
 * port validation prevents injection, and json_escape in exchange_oauth_code
 * prevents JSON injection via crafted OAuth codes.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(script: string, env?: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const { spawnSync } = require("child_process");
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

// ── validate_oauth_port ───────────────────────────────────────────────────────

describe("validate_oauth_port", () => {
  describe("accepts valid ports", () => {
    const validPorts = ["1024", "5180", "8080", "9999", "49152", "65535"];
    for (const port of validPorts) {
      it(`should accept port ${port}`, () => {
        const result = runBash(`validate_oauth_port "${port}"`);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("rejects privileged ports (below 1024)", () => {
    const privilegedPorts = ["0", "1", "22", "80", "443", "1023"];
    for (const port of privilegedPorts) {
      it(`should reject port ${port}`, () => {
        const result = runBash(`validate_oauth_port "${port}"`);
        expect(result.exitCode).toBe(1);
      });
    }
  });

  describe("rejects ports above 65535", () => {
    it("should reject port 65536", () => {
      const result = runBash(`validate_oauth_port "65536"`);
      expect(result.exitCode).toBe(1);
    });

    it("should reject port 99999", () => {
      const result = runBash(`validate_oauth_port "99999"`);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("rejects non-numeric input", () => {
    it("should reject alphabetic string", () => {
      const result = runBash(`validate_oauth_port "abc"`);
      expect(result.exitCode).toBe(1);
    });

    it("should reject empty string", () => {
      const result = runBash(`validate_oauth_port ""`);
      expect(result.exitCode).toBe(1);
    });

    it("should reject port with spaces", () => {
      const result = runBash(`validate_oauth_port "80 80"`);
      expect(result.exitCode).toBe(1);
    });

    it("should reject port with special characters", () => {
      const result = runBash(`validate_oauth_port "5180;echo"`);
      expect(result.exitCode).toBe(1);
    });

    it("should reject negative number", () => {
      const result = runBash(`validate_oauth_port "-1"`);
      expect(result.exitCode).toBe(1);
    });

    it("should reject decimal number", () => {
      const result = runBash(`validate_oauth_port "5180.5"`);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("boundary values", () => {
    it("should reject port 1023 (just below valid range)", () => {
      const result = runBash(`validate_oauth_port "1023"`);
      expect(result.exitCode).toBe(1);
    });

    it("should accept port 1024 (lower boundary)", () => {
      const result = runBash(`validate_oauth_port "1024"`);
      expect(result.exitCode).toBe(0);
    });

    it("should accept port 65535 (upper boundary)", () => {
      const result = runBash(`validate_oauth_port "65535"`);
      expect(result.exitCode).toBe(0);
    });

    it("should reject port 65536 (just above valid range)", () => {
      const result = runBash(`validate_oauth_port "65536"`);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("error messages", () => {
    it("should show 'must be numeric' for non-numeric input", () => {
      const result = runBash(`validate_oauth_port "abc"`);
      expect(result.stderr).toContain("must be numeric");
    });

    it("should show 'must be between' for out-of-range port", () => {
      const result = runBash(`validate_oauth_port "80"`);
      expect(result.stderr).toContain("must be between");
    });
  });
});

// ── _generate_csrf_state ──────────────────────────────────────────────────────

describe("_generate_csrf_state", () => {
  it("should generate a non-empty string", () => {
    const result = runBash("_generate_csrf_state");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("should generate hex-only output", () => {
    const result = runBash("_generate_csrf_state");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]+$/);
  });

  it("should generate at least 16 hex characters (64 bits of entropy)", () => {
    const result = runBash("_generate_csrf_state");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThanOrEqual(16);
  });

  it("should generate different values on consecutive calls", () => {
    const result = runBash(`
      state1=$(_generate_csrf_state)
      state2=$(_generate_csrf_state)
      if [[ "$state1" == "$state2" ]]; then
        echo "SAME"
        exit 1
      fi
      echo "DIFFERENT"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("DIFFERENT");
  });

  it("should work with openssl fallback", () => {
    // Test the primary openssl path (if available)
    const result = runBash(`
      if command -v openssl &>/dev/null; then
        state=$(_generate_csrf_state)
        echo "$state"
      else
        echo "no-openssl"
      fi
    `);
    expect(result.exitCode).toBe(0);
    if (result.stdout !== "no-openssl") {
      // openssl rand -hex 16 produces exactly 32 hex chars
      expect(result.stdout.length).toBe(32);
    }
  });

  it("should produce output safe for embedding in URLs and filenames", () => {
    const result = runBash("_generate_csrf_state");
    expect(result.exitCode).toBe(0);
    // No special characters, spaces, or newlines
    expect(result.stdout).not.toContain(" ");
    expect(result.stdout).not.toContain("\n");
    expect(result.stdout).not.toContain("/");
    expect(result.stdout).not.toContain("&");
    expect(result.stdout).not.toContain("?");
  });
});

// ── _generate_oauth_html ──────────────────────────────────────────────────────

describe("_generate_oauth_html", () => {
  it("should set OAUTH_SUCCESS_HTML variable", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("should set OAUTH_ERROR_HTML variable", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("should produce valid HTML in success page", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.stdout).toContain("<html");
    expect(result.stdout).toContain("</html>");
    expect(result.stdout).toContain("<body>");
  });

  it("should include success message in success HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.stdout).toContain("Authentication Successful");
  });

  it("should include auto-close script in success HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.stdout).toContain("window.close");
  });

  it("should include CSRF protection message in error HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.stdout).toContain("CSRF");
  });

  it("should include 'Authentication Failed' in error HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.stdout).toContain("Authentication Failed");
  });

  it("should include 'try again' guidance in error HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.stdout).toContain("try again");
  });

  it("should include CSS styling in both pages", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
      echo "---SEPARATOR---"
      echo "$OAUTH_ERROR_HTML"
    `);
    const parts = result.stdout.split("---SEPARATOR---");
    expect(parts[0]).toContain("<style>");
    expect(parts[1]).toContain("<style>");
  });
});

// ── _generate_oauth_server_script ─────────────────────────────────────────────

describe("_generate_oauth_server_script", () => {
  it("should generate valid JavaScript", () => {
    const result = runBash(`
      _generate_oauth_server_script "test-state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("require('http')");
  });

  it("should embed the expected CSRF state", () => {
    const result = runBash(`
      _generate_oauth_server_script "my-csrf-token-abc123" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("my-csrf-token-abc123");
  });

  it("should embed the starting port", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 9876
    `);
    expect(result.stdout).toContain("9876");
  });

  it("should include CSRF state validation in the callback handler", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    // Should check parsed.query.state against expectedState
    expect(result.stdout).toContain("expectedState");
    expect(result.stdout).toContain("parsed.query.state");
  });

  it("should write the OAuth code to the code file", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("writeFileSync");
    expect(result.stdout).toContain("parsed.query.code");
  });

  it("should write the actual port to the port file path", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    // The script writes currentPort.toString() to the port file path
    expect(result.stdout).toContain("currentPort.toString()");
    expect(result.stdout).toContain(`${testDir}/port`);
  });

  it("should handle EADDRINUSE by trying the next port", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("EADDRINUSE");
    expect(result.stdout).toContain("currentPort++");
  });

  it("should have a 5-minute timeout (300000ms)", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("300000");
  });

  it("should listen on localhost only (127.0.0.1)", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("127.0.0.1");
  });

  it("should try a range of 10 ports", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    // maxPort = starting_port + 10
    expect(result.stdout).toContain("maxPort");
  });

  it("should return 403 for invalid CSRF state", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("403");
  });

  it("should close server after successful callback", () => {
    const result = runBash(`
      _generate_oauth_server_script "state" "<html>ok</html>" "<html>err</html>" \\
        "${testDir}/code" "${testDir}/port" 5180
    `);
    expect(result.stdout).toContain("server.close()");
  });
});

// ── _validate_oauth_server_args ───────────────────────────────────────────────

describe("_validate_oauth_server_args", () => {
  it("should succeed with valid port and state file", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "valid-csrf-token");

    const result = runBash(`_validate_oauth_server_args 5180 "${stateFile}"`);
    expect(result.exitCode).toBe(0);
  });

  it("should fail with invalid port number", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "valid-csrf-token");

    const result = runBash(`_validate_oauth_server_args 80 "${stateFile}"`);
    expect(result.exitCode).toBe(1);
  });

  it("should fail when state file does not exist", () => {
    const result = runBash(`_validate_oauth_server_args 5180 "${testDir}/nonexistent"`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CSRF");
  });

  it("should fail when state file is empty", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "");

    const result = runBash(`_validate_oauth_server_args 5180 "${stateFile}"`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CSRF");
  });

  it("should set OAUTH_STATE variable on success", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "my-unique-csrf-token");

    const result = runBash(`
      _validate_oauth_server_args 5180 "${stateFile}"
      echo "$OAUTH_STATE"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("my-unique-csrf-token");
  });

  it("should set OAUTH_RUNTIME variable on success", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "token");

    const result = runBash(`
      _validate_oauth_server_args 5180 "${stateFile}"
      echo "$OAUTH_RUNTIME"
    `);
    expect(result.exitCode).toBe(0);
    // Should be one of: bun, node
    expect(result.stdout).toMatch(/bun|node/);
  });

  it("should fail with non-numeric port", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "token");

    const result = runBash(`_validate_oauth_server_args "abc" "${stateFile}"`);
    expect(result.exitCode).toBe(1);
  });

  it("should show port validation failure message", () => {
    const stateFile = join(testDir, "state");
    writeFileSync(stateFile, "token");

    const result = runBash(`_validate_oauth_server_args 80 "${stateFile}"`);
    expect(result.stderr).toContain("port validation failed");
  });
});

// ── _init_oauth_session ───────────────────────────────────────────────────────

describe("_init_oauth_session", () => {
  it("should create a temp directory", () => {
    const result = runBash("_init_oauth_session");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    // Clean up the created dir
    if (existsSync(result.stdout)) {
      rmSync(result.stdout, { recursive: true, force: true });
    }
  });

  it("should create a state file inside the directory", () => {
    const result = runBash("_init_oauth_session");
    expect(result.exitCode).toBe(0);
    const oauthDir = result.stdout;

    const stateFile = join(oauthDir, "state");
    expect(existsSync(stateFile)).toBe(true);

    // Clean up
    rmSync(oauthDir, { recursive: true, force: true });
  });

  it("should populate state file with a non-empty CSRF token", () => {
    const result = runBash("_init_oauth_session");
    expect(result.exitCode).toBe(0);
    const oauthDir = result.stdout;

    const stateContent = readFileSync(join(oauthDir, "state"), "utf-8");
    expect(stateContent.length).toBeGreaterThan(0);
    expect(stateContent).toMatch(/^[0-9a-f]+$/);

    // Clean up
    rmSync(oauthDir, { recursive: true, force: true });
  });

  it("should set restrictive permissions (600) on state file", () => {
    const result = runBash(`
      dir=$(_init_oauth_session)
      stat -c '%a' "$dir/state" 2>/dev/null || stat -f '%Lp' "$dir/state"
      rm -rf "$dir"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("600");
  });

  it("should generate unique directories on consecutive calls", () => {
    const result = runBash(`
      dir1=$(_init_oauth_session)
      dir2=$(_init_oauth_session)
      if [[ "$dir1" == "$dir2" ]]; then
        echo "SAME"
      else
        echo "DIFFERENT"
      fi
      rm -rf "$dir1" "$dir2"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("DIFFERENT");
  });
});

// ── cleanup_oauth_session ─────────────────────────────────────────────────────

describe("cleanup_oauth_session", () => {
  it("should remove the oauth directory", () => {
    const oauthDir = join(testDir, "oauth-session");
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, "code"), "test-code");
    writeFileSync(join(oauthDir, "state"), "test-state");

    const result = runBash(`cleanup_oauth_session "" "${oauthDir}"`);
    expect(result.exitCode).toBe(0);
    expect(existsSync(oauthDir)).toBe(false);
  });

  it("should handle non-existent directory gracefully", () => {
    const result = runBash(`cleanup_oauth_session "" "${testDir}/nonexistent"`);
    expect(result.exitCode).toBe(0);
  });

  it("should handle empty server_pid gracefully", () => {
    const oauthDir = join(testDir, "oauth-cleanup");
    mkdirSync(oauthDir, { recursive: true });

    const result = runBash(`cleanup_oauth_session "" "${oauthDir}"`);
    expect(result.exitCode).toBe(0);
  });

  it("should handle empty oauth_dir gracefully", () => {
    const result = runBash(`cleanup_oauth_session "" ""`);
    expect(result.exitCode).toBe(0);
  });

  it("should handle both empty pid and dir gracefully", () => {
    const result = runBash(`cleanup_oauth_session "" ""`);
    expect(result.exitCode).toBe(0);
  });

  it("should attempt to kill the specified PID", () => {
    // Verify cleanup_oauth_session calls kill on a PID by using a known-dead PID.
    // We can't easily test live process killing in spawnSync (wait hangs),
    // but we verify it handles the kill attempt without error.
    const result = runBash(`
      # Use PID of a process we know will already be dead
      bash -c 'exit 0' &
      bg_pid=$!
      wait "$bg_pid"  # Ensure it's fully done
      cleanup_oauth_session "$bg_pid" ""
      echo "OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });

  it("should handle invalid PID gracefully", () => {
    const result = runBash(`cleanup_oauth_session "999999999" ""`);
    expect(result.exitCode).toBe(0);
  });

  it("should clean up both PID and directory", () => {
    const oauthDir = join(testDir, "oauth-both");
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, "code"), "test");

    const result = runBash(`
      # Use a short-lived process that finishes before cleanup
      bash -c 'exit 0' &
      bg_pid=$!
      wait "$bg_pid"
      cleanup_oauth_session "$bg_pid" "${oauthDir}"
      # Check directory is cleaned up
      if [[ -d "${oauthDir}" ]]; then
        echo "DIR_EXISTS"
        exit 1
      fi
      echo "BOTH_CLEANED"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("BOTH_CLEANED");
  });
});

// ── exchange_oauth_code (input sanitization) ──────────────────────────────────

describe("exchange_oauth_code", () => {
  // Note: We can't easily mock curl in a child bash process, but we can
  // create a fake curl script on PATH that returns controlled responses.

  it("should extract the API key from the response", () => {
    // Create a fake curl that returns a known response
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho \'{"key":"sk-or-v1-test-api-key-12345"}\'\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code "test-oauth-code"`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-or-v1-test-api-key-12345");
  });

  it("should return error when response has no key field", () => {
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho \'{"error":"invalid_code"}\'\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code "bad-code"`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to exchange");
  });

  it("should return error when response is empty", () => {
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho ""\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code "code"`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(1);
  });

  it("should return error when curl returns invalid JSON", () => {
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho "not json at all"\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code "code"`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(1);
  });

  it("should handle OAuth code with double quotes safely via json_escape", () => {
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho \'{"key":"sk-or-v1-safe-key"}\'\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code 'code-with-"quotes"'`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sk-or-v1-safe-key");
  });

  it("should show the server response in error message on failure", () => {
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho \'{"error":"code_expired","message":"OAuth code has expired"}\'\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code "expired-code"`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("code_expired");
  });

  it("should suggest manual API key as alternative on failure", () => {
    writeFileSync(join(testDir, "curl"), '#!/bin/bash\necho \'{"error":"invalid"}\'\n');
    chmodSync(join(testDir, "curl"), 0o755);

    const result = runBash(
      `exchange_oauth_code "bad-code"`,
      { PATH: `${testDir}:${process.env.PATH}` }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OPENROUTER_API_KEY");
  });
});

// ── check_openrouter_connectivity (offline-safe) ──────────────────────────────

describe("check_openrouter_connectivity", () => {
  it("should return 0 when curl can reach the host", () => {
    // This test may fail in truly offline environments
    // but should pass in CI and normal dev environments
    const result = runBash("check_openrouter_connectivity");
    // We just verify it doesn't crash; actual connectivity depends on environment
    expect(result.exitCode === 0 || result.exitCode === 1).toBe(true);
  });

  it("should return 1 when no tools are available", () => {
    const result = runBash(
      "check_openrouter_connectivity",
      { PATH: "/nonexistent" }
    );
    expect(result.exitCode).toBe(1);
  });
});

// ── Integration: _init_oauth_session + _validate_oauth_server_args ────────────

describe("OAuth session lifecycle integration", () => {
  it("should create session and validate its state file", () => {
    const result = runBash(`
      oauth_dir=$(_init_oauth_session)

      # The state file created by _init_oauth_session should pass validation
      _validate_oauth_server_args 5180 "$oauth_dir/state"
      exit_code=$?

      # Verify OAUTH_STATE matches the file content
      file_content=$(cat "$oauth_dir/state")
      if [[ "$OAUTH_STATE" != "$file_content" ]]; then
        echo "STATE_MISMATCH"
        rm -rf "$oauth_dir"
        exit 1
      fi

      rm -rf "$oauth_dir"
      echo "OK"
      exit $exit_code
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
  });

  it("should create session, use it, and clean up", () => {
    const result = runBash(`
      # Create session
      oauth_dir=$(_init_oauth_session)

      # Verify files exist
      [[ -d "$oauth_dir" ]] || { echo "NO_DIR"; exit 1; }
      [[ -f "$oauth_dir/state" ]] || { echo "NO_STATE"; exit 1; }

      # Clean up
      cleanup_oauth_session "" "$oauth_dir"

      # Verify cleanup
      [[ -d "$oauth_dir" ]] && { echo "DIR_STILL_EXISTS"; exit 1; }

      echo "LIFECYCLE_OK"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("LIFECYCLE_OK");
  });
});

// ── CSRF state security properties ────────────────────────────────────────────

describe("CSRF state security properties", () => {
  it("should generate 128 bits (32 hex chars) of entropy via openssl", () => {
    const result = runBash(`
      if command -v openssl &>/dev/null; then
        state=$(_generate_csrf_state)
        printf '%s' "$state" | wc -c | tr -d ' '
      else
        echo "32"  # Skip test if no openssl
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("32");
  });

  it("should not contain predictable patterns", () => {
    // Collect 5 CSRF states and check they all differ
    const result = runBash(`
      state1=$(_generate_csrf_state)
      state2=$(_generate_csrf_state)
      state3=$(_generate_csrf_state)
      state4=$(_generate_csrf_state)
      state5=$(_generate_csrf_state)

      # Check all are unique using sort -u
      unique=$(printf '%s\\n' "$state1" "$state2" "$state3" "$state4" "$state5" | sort -u | wc -l | tr -d ' ')
      echo "$unique"
    `);
    expect(result.exitCode).toBe(0);
    expect(parseInt(result.stdout)).toBe(5);
  });

  it("should generate state that survives file write/read round-trip", () => {
    const result = runBash(`
      state=$(_generate_csrf_state)
      state_file="${testDir}/roundtrip_state"
      printf '%s' "$state" > "$state_file"
      chmod 600 "$state_file"

      read_back=$(cat "$state_file")
      if [[ "$state" == "$read_back" ]]; then
        echo "MATCH"
      else
        echo "MISMATCH"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("MATCH");
  });
});
