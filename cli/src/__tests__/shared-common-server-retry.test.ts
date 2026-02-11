import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for recently added/refactored bash functions in shared/common.sh:
 *
 * 1. get_validated_server_name (PR #535): New shared helper that replaced 18 duplicate
 *    get_server_name() functions across cloud providers. Called by every cloud's lib/common.sh.
 *
 * 2. _api_should_retry_on_error (PR #533): Refactored retry decision logic now called
 *    directly from _cloud_api_retry_loop instead of through removed wrapper functions.
 *
 * 3. _cloud_api_retry_loop (PR #533): The main API retry orchestrator that handles
 *    network failures, 429 rate limits, and 503 service unavailable responses.
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
 * Run a bash snippet and capture stderr merged into stdout.
 * Use this when you need to check log output (log_warn, log_error etc.)
 * from commands that exit 0.
 */
function runBashCapturingStderr(script: string): { exitCode: number; output: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  try {
    const output = execSync(`bash -c '${fullScript.replace(/'/g, "'\\''")}'  2>&1`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, output: output.trim() };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      output: ((err.stdout || "") + (err.stderr || "")).trim(),
    };
  }
}

// ── get_validated_server_name ───────────────────────────────────────────────

describe("get_validated_server_name", () => {
  describe("reads from environment variable", () => {
    it("should return name from env var when set", () => {
      const result = runBash(`
        export MY_SERVER_NAME="test-server-123"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test-server-123");
    });

    it("should validate name from env var", () => {
      // Name too short (less than 3 chars)
      const result = runBash(`
        export MY_SERVER_NAME="ab"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("too short");
    });

    it("should reject name with invalid characters from env var", () => {
      const result = runBash(`
        export MY_SERVER_NAME="bad_name!"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with leading dash from env var", () => {
      const result = runBash(`
        export MY_SERVER_NAME="-leading-dash"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with trailing dash from env var", () => {
      const result = runBash(`
        export MY_SERVER_NAME="trailing-dash-"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name longer than 63 characters from env var", () => {
      const longName = "a".repeat(64);
      const result = runBash(`
        export MY_SERVER_NAME="${longName}"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("too long");
    });

    it("should accept 3-character name (minimum valid)", () => {
      const result = runBash(`
        export MY_SERVER_NAME="abc"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("abc");
    });

    it("should accept 63-character name (maximum valid)", () => {
      const name = "a".repeat(63);
      const result = runBash(`
        export MY_SERVER_NAME="${name}"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(name);
    });

    it("should accept name with dashes in the middle", () => {
      const result = runBash(`
        export MY_SERVER_NAME="my-test-server"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("my-test-server");
    });

    it("should accept all-numeric name", () => {
      const result = runBash(`
        export MY_SERVER_NAME="12345"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("12345");
    });
  });

  describe("handles empty/missing env var", () => {
    it("should fail when env var is empty and no interactive input", () => {
      const result = runBash(`
        export MY_SERVER_NAME=""
        echo "" | get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      // Should fail because no value provided
      expect(result.exitCode).not.toBe(0);
    });

    it("should fail when env var is unset and no interactive input", () => {
      const result = runBash(`
        unset MY_SERVER_NAME
        echo "" | get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("injection prevention", () => {
    it("should reject command injection via env var", () => {
      const result = runBash(`
        export MY_SERVER_NAME='$(whoami)'
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject semicolon injection via env var", () => {
      const result = runBash(`
        export MY_SERVER_NAME="test; rm -rf /"
        get_validated_server_name "MY_SERVER_NAME" "Enter server name: "
      `);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject backtick injection via env var", () => {
      const result = runBash(
        'export MY_SERVER_NAME=\'test`whoami`\'\n' +
        'get_validated_server_name "MY_SERVER_NAME" "Enter server name: "'
      );
      expect(result.exitCode).not.toBe(0);
    });
  });
});

// ── _api_should_retry_on_error ──────────────────────────────────────────────

describe("_api_should_retry_on_error", () => {
  describe("retry decision logic", () => {
    it("should allow retry when attempt < max_retries", () => {
      // attempt=1, max_retries=3 -> should allow retry (exit 0)
      // Use sleep 0 replacement to avoid actual delay
      const result = runBash(`
        sleep() { :; }
        _api_should_retry_on_error 1 3 1 30 "Test error"
        echo "exit=$?"
      `);
      // The function returns 0 to indicate "retry"
      expect(result.stdout).toContain("exit=0");
    });

    it("should deny retry when attempt >= max_retries", () => {
      const result = runBash(`
        sleep() { :; }
        _api_should_retry_on_error 3 3 1 30 "Test error"
        echo "exit=$?"
      `);
      // The function returns 1 to indicate "don't retry"
      expect(result.stdout).toContain("exit=1");
    });

    it("should deny retry when attempt > max_retries", () => {
      const result = runBash(`
        sleep() { :; }
        _api_should_retry_on_error 5 3 1 30 "Test error"
        echo "exit=$?"
      `);
      expect(result.stdout).toContain("exit=1");
    });

    it("should deny retry on first attempt when max_retries is 1", () => {
      const result = runBash(`
        sleep() { :; }
        _api_should_retry_on_error 1 1 1 30 "Test error"
        echo "exit=$?"
      `);
      expect(result.stdout).toContain("exit=1");
    });

    it("should allow retry on first attempt when max_retries is 2", () => {
      const result = runBash(`
        sleep() { :; }
        _api_should_retry_on_error 1 2 1 30 "Test error"
        echo "exit=$?"
      `);
      expect(result.stdout).toContain("exit=0");
    });
  });

  describe("log output", () => {
    it("should include attempt number in warning message", () => {
      const result = runBashCapturingStderr(`
        sleep() { :; }
        _api_should_retry_on_error 2 5 1 30 "Cloud API rate limit"
      `);
      expect(result.output).toContain("attempt 2/5");
    });

    it("should include the error message in warning", () => {
      const result = runBashCapturingStderr(`
        sleep() { :; }
        _api_should_retry_on_error 1 3 1 30 "Cloud API network error"
      `);
      expect(result.output).toContain("Cloud API network error");
    });

    it("should include retry timing in warning message", () => {
      const result = runBashCapturingStderr(`
        sleep() { :; }
        _api_should_retry_on_error 1 3 5 30 "Test error"
      `);
      // Should mention retrying in Ns
      expect(result.output).toContain("retrying in");
    });
  });
});

// ── _cloud_api_retry_loop ───────────────────────────────────────────────────

describe("_cloud_api_retry_loop", () => {
  describe("successful API calls", () => {
    it("should return response body on HTTP 200", () => {
      const result = runBash(`
        mock_request() {
          API_HTTP_CODE="200"
          API_RESPONSE_BODY='{"status":"ok"}'
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('{"status":"ok"}');
    });

    it("should succeed on first attempt without retries", () => {
      const result = runBash(`
        ATTEMPT_COUNT=0
        mock_request() {
          ATTEMPT_COUNT=$((ATTEMPT_COUNT + 1))
          API_HTTP_CODE="200"
          API_RESPONSE_BODY="attempt=$ATTEMPT_COUNT"
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("attempt=1");
    });
  });

  describe("network errors (curl failures)", () => {
    it("should fail after exhausting retries on network error", () => {
      const result = runBash(`
        sleep() { :; }
        mock_request() {
          return 1  # simulate curl failure
        }
        _cloud_api_retry_loop mock_request 2 "test GET /api"
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("network error");
    });

    it("should retry on network error then succeed", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          if [[ "$CALL_NUM" -lt 2 ]]; then
            return 1  # first call fails
          fi
          API_HTTP_CODE="200"
          API_RESPONSE_BODY="recovered"
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("recovered");
    });
  });

  describe("HTTP 429 rate limit handling", () => {
    it("should retry on 429 and eventually succeed", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          if [[ "$CALL_NUM" -lt 2 ]]; then
            API_HTTP_CODE="429"
            API_RESPONSE_BODY='{"error":"rate_limit"}'
            return 0
          fi
          API_HTTP_CODE="200"
          API_RESPONSE_BODY='{"status":"ok"}'
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('{"status":"ok"}');
    });

    it("should fail after max retries on persistent 429", () => {
      const result = runBash(`
        sleep() { :; }
        mock_request() {
          API_HTTP_CODE="429"
          API_RESPONSE_BODY='{"error":"rate_limit"}'
          return 0
        }
        _cloud_api_retry_loop mock_request 2 "test GET /api"
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("429");
    });

    it("should log rate limit in retry warning", () => {
      const result = runBashCapturingStderr(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          if [[ "$CALL_NUM" -lt 2 ]]; then
            API_HTTP_CODE="429"
            API_RESPONSE_BODY='{}'
            return 0
          fi
          API_HTTP_CODE="200"
          API_RESPONSE_BODY='{}'
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.output).toContain("rate limit");
    });
  });

  describe("HTTP 503 service unavailable handling", () => {
    it("should retry on 503 and eventually succeed", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          if [[ "$CALL_NUM" -lt 2 ]]; then
            API_HTTP_CODE="503"
            API_RESPONSE_BODY='{"error":"service_unavailable"}'
            return 0
          fi
          API_HTTP_CODE="200"
          API_RESPONSE_BODY='{"status":"ok"}'
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('{"status":"ok"}');
    });

    it("should fail after max retries on persistent 503", () => {
      const result = runBash(`
        sleep() { :; }
        mock_request() {
          API_HTTP_CODE="503"
          API_RESPONSE_BODY='{"error":"service_unavailable"}'
          return 0
        }
        _cloud_api_retry_loop mock_request 2 "test GET /api"
      `);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("503");
    });

    it("should log service unavailable in retry warning", () => {
      const result = runBashCapturingStderr(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          if [[ "$CALL_NUM" -lt 2 ]]; then
            API_HTTP_CODE="503"
            API_RESPONSE_BODY='{}'
            return 0
          fi
          API_HTTP_CODE="200"
          API_RESPONSE_BODY='{}'
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.output).toContain("service unavailable");
    });
  });

  describe("non-retryable HTTP errors", () => {
    it("should return response body on HTTP 400 without retry", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          API_HTTP_CODE="400"
          API_RESPONSE_BODY="attempt=$CALL_NUM"
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      // Should return on first attempt since 400 is not retryable
      expect(result.stdout).toBe("attempt=1");
    });

    it("should not retry on HTTP 401", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          API_HTTP_CODE="401"
          API_RESPONSE_BODY="attempt=$CALL_NUM"
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("attempt=1");
    });

    it("should not retry on HTTP 404", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          API_HTTP_CODE="404"
          API_RESPONSE_BODY="attempt=$CALL_NUM"
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("attempt=1");
    });

    it("should not retry on HTTP 500", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          API_HTTP_CODE="500"
          API_RESPONSE_BODY="attempt=$CALL_NUM"
          return 0
        }
        _cloud_api_retry_loop mock_request 3 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("attempt=1");
    });
  });

  describe("mixed failure scenarios", () => {
    it("should handle network error then 429 then success", () => {
      const result = runBash(`
        sleep() { :; }
        CALL_NUM=0
        mock_request() {
          CALL_NUM=$((CALL_NUM + 1))
          if [[ "$CALL_NUM" -eq 1 ]]; then
            return 1  # network error
          fi
          if [[ "$CALL_NUM" -eq 2 ]]; then
            API_HTTP_CODE="429"
            API_RESPONSE_BODY='{}'
            return 0
          fi
          API_HTTP_CODE="200"
          API_RESPONSE_BODY="success-on-attempt-$CALL_NUM"
          return 0
        }
        _cloud_api_retry_loop mock_request 5 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("success-on-attempt-3");
    });
  });

  describe("max_retries edge cases", () => {
    it("should succeed on single allowed attempt with good response", () => {
      const result = runBash(`
        mock_request() {
          API_HTTP_CODE="200"
          API_RESPONSE_BODY="single-attempt"
          return 0
        }
        _cloud_api_retry_loop mock_request 1 "test GET /api"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("single-attempt");
    });

    it("should fail on single allowed attempt with network error", () => {
      const result = runBash(`
        sleep() { :; }
        mock_request() {
          return 1
        }
        _cloud_api_retry_loop mock_request 1 "test GET /api"
      `);
      expect(result.exitCode).not.toBe(0);
    });
  });
});
