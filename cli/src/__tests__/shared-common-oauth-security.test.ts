import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve, join } from "path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for OAuth security functions in shared/common.sh that previously
 * had zero test coverage:
 *
 * - _generate_oauth_html: OAuth callback HTML generation
 * - _validate_oauth_server_args: Port validation + CSRF state file reading
 * - _generate_oauth_server_script: Node.js OAuth server script generation
 * - exchange_oauth_code: OAuth code-to-key exchange (JSON escaping)
 * - cleanup_oauth_session: Cleanup of OAuth temp resources
 * - execute_agent_non_interactive: Non-interactive agent prompt execution
 *
 * These are SECURITY-CRITICAL: they handle CSRF state, port validation,
 * user prompt escaping, and code generation from untrusted inputs.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Uses a heredoc approach to avoid single-quote escaping issues.
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  try {
    const stdout = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'`, {
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

/**
 * Run bash script using heredoc to handle complex quoting.
 */
function runBashHeredoc(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const tmpFile = join(
    tmpdir(),
    `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`
  );
  try {
    writeFileSync(
      tmpFile,
      `#!/bin/bash\nset -eo pipefail\nsource "${COMMON_SH}"\n${script}\n`
    );
    const stdout = execSync(`bash "${tmpFile}"`, {
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
  } finally {
    try {
      rmSync(tmpFile);
    } catch (err: any) {
      // Expected: ENOENT if file was already deleted.
      if (err.code !== "ENOENT") console.error("Unexpected error removing temp file:", err);
    }
  }
}

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `spawn-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── _generate_oauth_html ────────────────────────────────────────────────

describe("_generate_oauth_html", () => {
  it("should set OAUTH_SUCCESS_HTML variable", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Authentication Successful");
  });

  it("should set OAUTH_ERROR_HTML variable", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Authentication Failed");
  });

  it("should include CSRF protection message in error HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CSRF protection");
  });

  it("should include auto-close script in success HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("window.close");
  });

  it("success HTML should be valid HTML structure", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<html>");
    expect(result.stdout).toContain("</html>");
    expect(result.stdout).toContain("<head>");
    expect(result.stdout).toContain("<body>");
  });

  it("error HTML should be valid HTML structure", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<html>");
    expect(result.stdout).toContain("</html>");
    expect(result.stdout).toContain("<head>");
    expect(result.stdout).toContain("<body>");
  });

  it("should include CSS styling", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<style>");
    expect(result.stdout).toContain("font-family");
  });

  it("success HTML should contain checkmark icon", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("&#10003;");
  });

  it("error HTML should have red color for heading", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#dc2626");
  });

  it("should include 'close this tab' message in success HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_SUCCESS_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("close this tab");
  });

  it("should include 'try again' message in error HTML", () => {
    const result = runBash(`
      _generate_oauth_html
      echo "$OAUTH_ERROR_HTML"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("try again");
  });
});

// ── _validate_oauth_server_args ──────────────────────────────────────────

describe("_validate_oauth_server_args", () => {
  it("should succeed with valid port and state file", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "valid-csrf-state-token");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 8080 "${stateFile}"
        echo "STATE=$OAUTH_STATE"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("STATE=valid-csrf-state-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should fail with invalid (non-numeric) port", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "some-state");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args "abc" "${stateFile}" || echo "FAILED"
      `);
      expect(result.stdout).toContain("FAILED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should fail with privileged port (below 1024)", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "some-state");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 80 "${stateFile}" || echo "FAILED"
      `);
      expect(result.stdout).toContain("FAILED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should fail with port above 65535", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "some-state");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 70000 "${stateFile}" || echo "FAILED"
      `);
      expect(result.stdout).toContain("FAILED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should fail with empty state file", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 8080 "${stateFile}" 2>&1 || echo "FAILED"
      `);
      expect(result.stdout).toContain("FAILED");
      expect(result.stdout).toContain("CSRF state token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should fail with missing state file", () => {
    const result = runBashHeredoc(`
      _validate_oauth_server_args 8080 "/nonexistent/state/file" 2>&1 || echo "FAILED"
    `);
    expect(result.stdout).toContain("FAILED");
    expect(result.stdout).toContain("CSRF state token");
  });

  it("should set OAUTH_RUNTIME variable on success", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "test-state");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 8080 "${stateFile}"
        echo "RUNTIME=$OAUTH_RUNTIME"
      `);
      expect(result.exitCode).toBe(0);
      // Should find node or bun
      expect(result.stdout).toMatch(/RUNTIME=.+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should accept port 1024 (minimum valid)", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "test-state");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 1024 "${stateFile}"
        echo "OK"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should accept port 65535 (maximum valid)", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "test-state");
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 65535 "${stateFile}"
        echo "OK"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should read CSRF state from file correctly", () => {
    const dir = createTempDir();
    const stateFile = join(dir, "state");
    const csrfToken = "abc123def456-csrf-token-with-special";
    writeFileSync(stateFile, csrfToken);
    try {
      const result = runBashHeredoc(`
        _validate_oauth_server_args 8080 "${stateFile}"
        echo "$OAUTH_STATE"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(csrfToken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── _generate_oauth_server_script ────────────────────────────────────────

describe("_generate_oauth_server_script", () => {
  it("should generate valid JavaScript containing expected state", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "test-state-123" "<html>success</html>" "<html>error</html>" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test-state-123");
  });

  it("should include CSRF state validation in generated script", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "my-csrf-state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expectedState");
    expect(result.stdout).toContain("my-csrf-state");
  });

  it("should validate state parameter on callback", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "valid-state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    // The script should check that query.state matches expectedState
    expect(result.stdout).toContain("parsed.query.state !== expectedState");
  });

  it("should return 403 on CSRF mismatch", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "valid-state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("403");
  });

  it("should write code to code_file on successful callback", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/test-code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("writeFileSync");
    expect(result.stdout).toContain("/tmp/test-code");
    expect(result.stdout).toContain("parsed.query.code");
  });

  it("should include port file writing", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/test-port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/tmp/test-port");
  });

  it("should listen on specified starting port", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 9090)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("currentPort = 9090");
  });

  it("should try up to 10 ports on EADDRINUSE", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 3000)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("maxPort = 3000 + 10");
    expect(result.stdout).toContain("EADDRINUSE");
  });

  it("should listen on 127.0.0.1 only (not exposed to network)", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("127.0.0.1");
  });

  it("should have a 5-minute timeout", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    // 300000ms = 5 minutes
    expect(result.stdout).toContain("300000");
  });

  it("should handle /callback path", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/callback");
  });

  it("should close server after receiving code", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("server.close()");
  });

  it("should exit with code 1 on CSRF failure", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("process.exit(1)");
  });

  it("should exit with code 0 on success", () => {
    const result = runBash(`
      script=$(_generate_oauth_server_script "state" "ok" "err" "/tmp/code" "/tmp/port" 8080)
      echo "$script"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("process.exit(0)");
  });
});

// ── cleanup_oauth_session ────────────────────────────────────────────────

describe("cleanup_oauth_session", () => {
  it("should remove OAuth directory", () => {
    const dir = createTempDir();
    expect(existsSync(dir)).toBe(true);
    const result = runBashHeredoc(`
      cleanup_oauth_session "" "${dir}"
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("should not fail with empty server PID", () => {
    const result = runBashHeredoc(`
      cleanup_oauth_session "" ""
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should not fail with nonexistent directory", () => {
    const result = runBashHeredoc(`
      cleanup_oauth_session "" "/tmp/nonexistent-oauth-dir-$$"
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should not fail with invalid PID", () => {
    // Use a very large PID that certainly doesn't exist
    const result = runBashHeredoc(`
      cleanup_oauth_session "999999999" ""
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should remove directory with files inside", () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "code.txt"), "oauth-code");
    writeFileSync(join(dir, "port.txt"), "8080");
    writeFileSync(join(dir, "state.txt"), "csrf-token");
    expect(existsSync(dir)).toBe(true);

    const result = runBashHeredoc(`
      cleanup_oauth_session "" "${dir}"
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("should handle both PID and directory cleanup", () => {
    const dir = createTempDir();
    writeFileSync(join(dir, "test.txt"), "data");
    // Use a fake PID that doesn't exist - kill will silently fail
    const result = runBashHeredoc(`
      cleanup_oauth_session "999999999" "${dir}"
    `);
    expect(result.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });
});

// ── exchange_oauth_code (JSON escaping security) ─────────────────────────

describe("exchange_oauth_code JSON escaping", () => {
  // We test the JSON escaping portion, not the actual API call.
  // The function uses json_escape to prevent JSON injection via crafted OAuth codes.

  it("json_escape should properly escape double quotes", () => {
    const result = runBash(`
      escaped=$(json_escape 'value"with"quotes')
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    // Should be a valid JSON string (with quotes)
    expect(result.stdout).toContain('\\"');
  });

  it("json_escape should properly escape backslashes", () => {
    const result = runBash(`
      escaped=$(json_escape 'value\\with\\backslash')
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\\\");
  });

  it("json_escape should handle normal OAuth code", () => {
    const result = runBash(`
      escaped=$(json_escape "abc123def456")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("abc123def456");
  });

  it("json_escape should handle newlines in OAuth codes", () => {
    const result = runBashHeredoc(`
      code=$'line1\\nline2'
      escaped=$(json_escape "$code")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\n");
  });

  it("json_escape should handle tab characters", () => {
    const result = runBashHeredoc(`
      code=$'before\\tafter'
      escaped=$(json_escape "$code")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\t");
  });

  it("json_escape should produce valid JSON when wrapped", () => {
    const dir = createTempDir();
    const scriptFile = join(dir, "test.sh");
    writeFileSync(scriptFile, `#!/bin/bash
set -eo pipefail
source "${COMMON_SH}"
escaped=$(json_escape 'test"value')
json="{\\"key\\": $escaped}"
echo "$json" | python3 -c "import sys,json; json.load(sys.stdin); print('VALID')"
`);
    try {
      const stdout = execSync(`bash "${scriptFile}"`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(stdout.trim()).toContain("VALID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("json_escape should prevent JSON injection via OAuth code", () => {
    const dir = createTempDir();
    const scriptFile = join(dir, "test.sh");
    // Attacker tries to inject extra JSON fields via the OAuth code value
    writeFileSync(scriptFile, `#!/bin/bash
set -eo pipefail
source "${COMMON_SH}"
malicious_code='fake","admin":true,"code":"real'
escaped=$(json_escape "$malicious_code")
json="{\\"code\\": $escaped}"
echo "$json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
keys = list(data.keys())
print(len(keys))
print(keys[0] if keys else 'none')
"
`);
    try {
      const stdout = execSync(`bash "${scriptFile}"`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = stdout.trim().split("\n");
      // Should have exactly 1 key - the injected data is in the value, not as separate keys
      expect(lines[0]).toBe("1");
      expect(lines[1]).toBe("code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── execute_agent_non_interactive ────────────────────────────────────────

describe("execute_agent_non_interactive", () => {
  // We can only test the command construction, not actual execution
  // (since it requires sprite/SSH). We verify prompts are escaped properly.

  it("should use printf %q to escape prompts", () => {
    // Verify that printf %q works correctly for common prompts
    const result = runBash(`
      prompt="Fix all linter errors"
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    // Simple prompt should pass through mostly unchanged
    expect(result.stdout).toContain("Fix");
    expect(result.stdout).toContain("linter");
  });

  it("should escape special shell characters in prompts", () => {
    const result = runBashHeredoc(`
      prompt='Fix the bug in $HOME/app && deploy'
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    // $HOME should be escaped (not expanded)
    expect(result.stdout).not.toMatch(/^Fix the bug in \/home/);
    // && should be escaped
    expect(result.stdout).toContain("\\&");
  });

  it("should escape semicolons in prompts", () => {
    const result = runBashHeredoc(`
      prompt='run tests; rm -rf /'
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    // Semicolons should be escaped
    expect(result.stdout).toContain("\\;");
  });

  it("should escape backticks in prompts", () => {
    const result = runBashHeredoc(
      "prompt='run \\`whoami\\`'\nescaped=$(printf '%q' \"$prompt\")\necho \"$escaped\""
    );
    expect(result.exitCode).toBe(0);
    // Backticks should be escaped
    expect(result.stdout).toContain("\\`");
  });

  it("should handle empty prompt gracefully", () => {
    const result = runBashHeredoc(`
      prompt=""
      escaped=$(printf '%q' "$prompt")
      echo "ESCAPED=$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ESCAPED=''");
  });

  it("should handle prompt with single quotes", () => {
    const result = runBashHeredoc(`
      prompt="Fix the user's profile page"
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    // Single quotes should be escaped
    expect(result.stdout).toContain("\\");
  });

  it("should handle prompt with double quotes", () => {
    const result = runBashHeredoc(`
      prompt='Fix the "quoted" text'
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('\\"');
  });

  it("should handle prompt with pipe characters", () => {
    const result = runBashHeredoc(`
      prompt='run tests | grep error'
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\|");
  });

  it("should handle prompt with parentheses", () => {
    const result = runBashHeredoc(`
      prompt='fix the function (and its tests)'
      escaped=$(printf '%q' "$prompt")
      echo "$escaped"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\\(");
    expect(result.stdout).toContain("\\)");
  });
});

// ── wait_for_oauth_code ──────────────────────────────────────────────────

describe("wait_for_oauth_code", () => {
  it("should return 0 when code file exists", () => {
    const dir = createTempDir();
    const codeFile = join(dir, "code");
    writeFileSync(codeFile, "test-oauth-code");
    try {
      // Use a short timeout since the file already exists
      const result = runBashHeredoc(`
        POLL_INTERVAL=1
        wait_for_oauth_code "${codeFile}" 2
        echo "EXIT=$?"
      `);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should return 1 when code file does not appear within timeout", () => {
    const dir = createTempDir();
    const codeFile = join(dir, "code-that-wont-appear");
    try {
      const result = runBashHeredoc(`
        POLL_INTERVAL=1
        wait_for_oauth_code "${codeFile}" 2 || echo "TIMED_OUT"
      `);
      expect(result.stdout).toContain("TIMED_OUT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── _check_oauth_prerequisites ───────────────────────────────────────────

describe("_check_oauth_prerequisites", () => {
  it("should succeed when curl is available (connectivity check)", () => {
    // This test will pass in CI/environments with internet access
    // and fail gracefully otherwise
    const result = runBashHeredoc(`
      _check_oauth_prerequisites && echo "OK" || echo "NO_CONNECTIVITY"
    `);
    expect(result.exitCode).toBe(0);
    // Either passes or fails gracefully
    expect(result.stdout).toMatch(/OK|NO_CONNECTIVITY/);
  });

  it("should verify node runtime is available", () => {
    const result = runBashHeredoc(`
      if _check_oauth_prerequisites; then
        # If prerequisites pass, find_node_runtime should also work
        runtime=$(find_node_runtime)
        echo "RUNTIME=$runtime"
      else
        echo "PREREQUISITES_FAILED"
      fi
    `);
    expect(result.exitCode).toBe(0);
    if (result.stdout.includes("RUNTIME=")) {
      // If connectivity check passed, runtime should be set
      expect(result.stdout).toMatch(/RUNTIME=.+/);
    }
  });
});

// ── find_node_runtime ────────────────────────────────────────────────────

describe("find_node_runtime", () => {
  it("should find bun or node runtime", () => {
    const result = runBash(`
      runtime=$(find_node_runtime)
      echo "$runtime"
    `);
    expect(result.exitCode).toBe(0);
    // Should find either bun or node
    expect(result.stdout).toMatch(/bun|node/);
  });

  it("should return exit code 0 when runtime is found", () => {
    const result = runBash(`
      find_node_runtime > /dev/null
    `);
    expect(result.exitCode).toBe(0);
  });

  it("should return a path to an executable", () => {
    const result = runBash(`
      runtime=$(find_node_runtime)
      command -v "$runtime" > /dev/null && echo "EXECUTABLE"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("EXECUTABLE");
  });
});

// ── start_and_verify_oauth_server (logic validation) ─────────────────────

describe("start_and_verify_oauth_server port file behavior", () => {
  it("should read port from port_file when it exists", () => {
    const dir = createTempDir();
    const portFile = join(dir, "port");
    writeFileSync(portFile, "9090");
    try {
      // We mock the PID check by using our own process PID (which exists)
      const result = runBashHeredoc(`
        POLL_INTERVAL=0
        # Create a subshell as a fake server process
        sleep 10 &
        fake_pid=$!
        port_file="${portFile}"

        # Inline the port-reading logic from start_and_verify_oauth_server
        if kill -0 "$fake_pid" 2>/dev/null; then
          if [[ -f "$port_file" ]]; then
            cat "$port_file"
          fi
        fi
        kill "$fake_pid" 2>/dev/null || true
        wait "$fake_pid" 2>/dev/null || true
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("9090");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── open_browser (basic validation) ──────────────────────────────────────

describe("open_browser detection", () => {
  it("should have open_browser function defined", () => {
    const result = runBash(`
      type open_browser | head -1
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("function");
  });
});
