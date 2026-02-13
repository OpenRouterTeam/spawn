import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for _classify_api_result and _report_api_failure in shared/common.sh.
 *
 * These two helpers were extracted from _cloud_api_retry_loop in PR #821 to
 * reduce its cyclomatic complexity. They had zero test coverage despite being
 * invoked on EVERY cloud API call across ALL providers:
 *
 * - _classify_api_result: Decides whether to retry based on curl exit code
 *   and HTTP status code. Returns a reason string or empty (success).
 *   A bug here could cause infinite retries or silent failures.
 *
 * - _report_api_failure: Generates user-facing error messages after all
 *   retries are exhausted. Differentiates network errors from HTTP errors
 *   and includes the API response body for HTTP errors only.
 *
 * Tests run the actual bash functions in subprocesses to catch real shell
 * behavior (quoting, variable expansion, exit codes).
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(
  script: string,
  env?: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
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

// ── _classify_api_result ────────────────────────────────────────────────────

describe("_classify_api_result", () => {
  describe("network errors (curl failures)", () => {
    it("should return network error message when curl exits non-zero", () => {
      const result = runBash(`
        API_HTTP_CODE=""
        echo "$(_classify_api_result 1)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API network error");
    });

    it("should return network error for curl exit code 6 (DNS failure)", () => {
      const result = runBash(`
        API_HTTP_CODE=""
        echo "$(_classify_api_result 6)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API network error");
    });

    it("should return network error for curl exit code 7 (connection refused)", () => {
      const result = runBash(`
        API_HTTP_CODE=""
        echo "$(_classify_api_result 7)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API network error");
    });

    it("should return network error for curl exit code 28 (timeout)", () => {
      const result = runBash(`
        API_HTTP_CODE=""
        echo "$(_classify_api_result 28)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API network error");
    });

    it("should prioritize curl failure over HTTP code", () => {
      // If curl itself failed, the HTTP code is meaningless
      const result = runBash(`
        API_HTTP_CODE="200"
        echo "$(_classify_api_result 7)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API network error");
    });
  });

  describe("HTTP rate limiting (429)", () => {
    it("should detect HTTP 429 rate limit", () => {
      const result = runBash(`
        API_HTTP_CODE="429"
        echo "$(_classify_api_result 0)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API returned rate limit (HTTP 429)");
    });

    it("should include HTTP 429 in the message", () => {
      const result = runBash(`
        API_HTTP_CODE="429"
        result=$(_classify_api_result 0)
        echo "$result"
      `);
      expect(result.stdout).toContain("429");
      expect(result.stdout).toContain("rate limit");
    });
  });

  describe("HTTP service unavailable (503)", () => {
    it("should detect HTTP 503 service unavailable", () => {
      const result = runBash(`
        API_HTTP_CODE="503"
        echo "$(_classify_api_result 0)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API returned service unavailable (HTTP 503)");
    });

    it("should include HTTP 503 in the message", () => {
      const result = runBash(`
        API_HTTP_CODE="503"
        result=$(_classify_api_result 0)
        echo "$result"
      `);
      expect(result.stdout).toContain("503");
      expect(result.stdout).toContain("service unavailable");
    });
  });

  describe("success cases (no retry needed)", () => {
    it("should return empty string for successful request (HTTP 200)", () => {
      const result = runBash(`
        API_HTTP_CODE="200"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then
          echo "EMPTY"
        else
          echo "$result"
        fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty string for HTTP 201 (created)", () => {
      const result = runBash(`
        API_HTTP_CODE="201"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty string for HTTP 204 (no content)", () => {
      const result = runBash(`
        API_HTTP_CODE="204"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty string for HTTP 301 (redirect)", () => {
      const result = runBash(`
        API_HTTP_CODE="301"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });
  });

  describe("non-retryable HTTP errors (not classified)", () => {
    it("should return empty for HTTP 400 (bad request)", () => {
      const result = runBash(`
        API_HTTP_CODE="400"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty for HTTP 401 (unauthorized)", () => {
      const result = runBash(`
        API_HTTP_CODE="401"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty for HTTP 403 (forbidden)", () => {
      const result = runBash(`
        API_HTTP_CODE="403"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty for HTTP 404 (not found)", () => {
      const result = runBash(`
        API_HTTP_CODE="404"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty for HTTP 409 (conflict)", () => {
      const result = runBash(`
        API_HTTP_CODE="409"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty for HTTP 500 (internal server error)", () => {
      const result = runBash(`
        API_HTTP_CODE="500"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should return empty for HTTP 502 (bad gateway)", () => {
      const result = runBash(`
        API_HTTP_CODE="502"
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });
  });

  describe("edge cases", () => {
    it("should handle empty API_HTTP_CODE with curl success", () => {
      const result = runBash(`
        API_HTTP_CODE=""
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should handle unset API_HTTP_CODE with curl success", () => {
      const result = runBash(`
        unset API_HTTP_CODE
        result=$(_classify_api_result 0)
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should treat curl_ok string '0' as success", () => {
      const result = runBash(`
        API_HTTP_CODE="200"
        result=$(_classify_api_result "0")
        if [[ -z "$result" ]]; then echo "EMPTY"; else echo "$result"; fi
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("EMPTY");
    });

    it("should treat any non-zero curl_ok as network error", () => {
      const result = runBash(`
        API_HTTP_CODE="200"
        echo "$(_classify_api_result 99)"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Cloud API network error");
    });
  });
});

// ── _report_api_failure ─────────────────────────────────────────────────────

describe("_report_api_failure", () => {
  describe("network error reporting", () => {
    it("should show retry count in error message", () => {
      const result = runBash(`
        API_RESPONSE_BODY=""
        _report_api_failure "Cloud API network error" 3
      `);
      expect(result.stderr).toContain("Cloud API network error");
      expect(result.stderr).toContain("3 attempts");
    });

    it("should suggest checking internet connection for network errors", () => {
      const result = runBash(`
        API_RESPONSE_BODY=""
        _report_api_failure "Cloud API network error" 5
      `);
      expect(result.stderr).toContain("internet connection");
    });

    it("should NOT output API response body for network errors", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{"error": "should not appear"}'
        _report_api_failure "Cloud API network error" 3
      `);
      expect(result.stdout).not.toContain("should not appear");
    });
  });

  describe("HTTP error reporting", () => {
    it("should show rate limit reason in error message", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{"error": "rate limited"}'
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.stderr).toContain("rate limit");
      expect(result.stderr).toContain("3 attempts");
    });

    it("should output API response body for HTTP errors", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{"error": "rate limited"}'
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.stdout).toContain("rate limited");
    });

    it("should output API response body for 503 errors", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{"error": "service unavailable"}'
        _report_api_failure "Cloud API returned service unavailable (HTTP 503)" 3
      `);
      expect(result.stdout).toContain("service unavailable");
    });

    it("should suggest waiting and retrying for HTTP errors", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{}'
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.stderr).toContain("rate limiting");
      expect(result.stderr).toContain("try again");
    });

    it("should suggest checking status page for HTTP errors", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{}'
        _report_api_failure "Cloud API returned service unavailable (HTTP 503)" 3
      `);
      expect(result.stderr).toContain("status page");
    });
  });

  describe("retry count display", () => {
    it("should show 1 attempt for single retry", () => {
      const result = runBash(`
        API_RESPONSE_BODY=""
        _report_api_failure "Cloud API network error" 1
      `);
      expect(result.stderr).toContain("1 attempts");
    });

    it("should show 5 attempts for max retries", () => {
      const result = runBash(`
        API_RESPONSE_BODY=""
        _report_api_failure "Cloud API network error" 5
      `);
      expect(result.stderr).toContain("5 attempts");
    });

    it("should show 10 attempts for large retry count", () => {
      const result = runBash(`
        API_RESPONSE_BODY=""
        _report_api_failure "Cloud API network error" 10
      `);
      expect(result.stderr).toContain("10 attempts");
    });
  });

  describe("API response body handling", () => {
    it("should handle empty API response body", () => {
      const result = runBash(`
        API_RESPONSE_BODY=""
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.exitCode).toBe(0);
      // Should still print the error message, just empty body
      expect(result.stderr).toContain("rate limit");
    });

    it("should handle multiline API response body", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{"error": "rate limited",
  "retry_after": 60,
  "message": "Please slow down"}'
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.stdout).toContain("rate limited");
      expect(result.stdout).toContain("retry_after");
    });

    it("should handle API response body with special characters", () => {
      const result = runBash(`
        API_RESPONSE_BODY='{"error": "quota exceeded: \$100 limit"}'
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.exitCode).toBe(0);
      // Should not crash on special chars
      expect(result.stderr).toContain("rate limit");
    });

    it("should handle very long API response body", () => {
      const result = runBash(`
        API_RESPONSE_BODY=$(printf 'x%.0s' {1..1000})
        _report_api_failure "Cloud API returned rate limit (HTTP 429)" 3
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(500);
    });
  });
});

// ── Integration: _classify_api_result + _report_api_failure ─────────────────

describe("_classify_api_result + _report_api_failure integration", () => {
  it("should classify network error and report appropriately", () => {
    const result = runBash(`
      API_HTTP_CODE=""
      API_RESPONSE_BODY=""
      reason=$(_classify_api_result 7)
      if [[ -n "$reason" ]]; then
        _report_api_failure "$reason" 3
        echo "CLASSIFIED:$reason"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CLASSIFIED:Cloud API network error");
    expect(result.stderr).toContain("internet connection");
  });

  it("should classify rate limit and report with response body", () => {
    const result = runBash(`
      API_HTTP_CODE="429"
      API_RESPONSE_BODY='{"error": "too many requests"}'
      reason=$(_classify_api_result 0)
      if [[ -n "$reason" ]]; then
        _report_api_failure "$reason" 3
        echo "CLASSIFIED:$reason"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("too many requests");
    expect(result.stdout).toContain("CLASSIFIED:Cloud API returned rate limit (HTTP 429)");
  });

  it("should classify 503 and report with response body", () => {
    const result = runBash(`
      API_HTTP_CODE="503"
      API_RESPONSE_BODY='{"error": "maintenance"}'
      reason=$(_classify_api_result 0)
      if [[ -n "$reason" ]]; then
        _report_api_failure "$reason" 5
        echo "CLASSIFIED:$reason"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("maintenance");
    expect(result.stdout).toContain("CLASSIFIED:Cloud API returned service unavailable (HTTP 503)");
  });

  it("should return empty for successful request (no report needed)", () => {
    const result = runBash(`
      API_HTTP_CODE="200"
      API_RESPONSE_BODY='{"id": "srv-123"}'
      reason=$(_classify_api_result 0)
      if [[ -z "$reason" ]]; then
        echo "SUCCESS"
      else
        echo "SHOULD_RETRY:$reason"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("SUCCESS");
  });

  it("should return empty for 404 (not retryable, caller handles)", () => {
    const result = runBash(`
      API_HTTP_CODE="404"
      API_RESPONSE_BODY='{"error": "not found"}'
      reason=$(_classify_api_result 0)
      if [[ -z "$reason" ]]; then
        echo "NOT_RETRYABLE"
      else
        echo "SHOULD_RETRY:$reason"
      fi
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("NOT_RETRYABLE");
  });
});

// ── Realistic cloud provider scenarios ──────────────────────────────────────

describe("realistic cloud provider scenarios", () => {
  it("should handle Hetzner rate limit response", () => {
    const result = runBash(`
      API_HTTP_CODE="429"
      API_RESPONSE_BODY='{"error":{"message":"Rate limit exceeded","code":"rate_limit_exceeded"}}'
      reason=$(_classify_api_result 0)
      echo "REASON:$reason"
    `);
    expect(result.stdout).toContain("rate limit");
  });

  it("should handle DigitalOcean 503 response", () => {
    const result = runBash(`
      API_HTTP_CODE="503"
      API_RESPONSE_BODY='{"id":"service_unavailable","message":"Server Error"}'
      reason=$(_classify_api_result 0)
      _report_api_failure "$reason" 3
    `);
    expect(result.stderr).toContain("service unavailable");
    expect(result.stderr).toContain("status page");
    expect(result.stdout).toContain("service_unavailable");
  });

  it("should handle DNS resolution failure", () => {
    const result = runBash(`
      API_HTTP_CODE=""
      API_RESPONSE_BODY=""
      reason=$(_classify_api_result 6)
      _report_api_failure "$reason" 3
    `);
    expect(result.stderr).toContain("network error");
    expect(result.stderr).toContain("internet connection");
  });

  it("should handle connection timeout", () => {
    const result = runBash(`
      API_HTTP_CODE=""
      API_RESPONSE_BODY=""
      reason=$(_classify_api_result 28)
      _report_api_failure "$reason" 3
    `);
    expect(result.stderr).toContain("network error");
  });

  it("should not retry on auth failure (401)", () => {
    const result = runBash(`
      API_HTTP_CODE="401"
      API_RESPONSE_BODY='{"error":"invalid_token"}'
      reason=$(_classify_api_result 0)
      if [[ -z "$reason" ]]; then
        echo "NO_RETRY"
      else
        echo "RETRY:$reason"
      fi
    `);
    expect(result.stdout).toBe("NO_RETRY");
  });

  it("should not retry on quota exceeded (402/403)", () => {
    const result = runBash(`
      API_HTTP_CODE="402"
      API_RESPONSE_BODY='{"error":"payment_required"}'
      reason=$(_classify_api_result 0)
      if [[ -z "$reason" ]]; then echo "NO_RETRY"; else echo "RETRY:$reason"; fi
    `);
    expect(result.stdout).toBe("NO_RETRY");
  });

  it("should not retry on validation error (422)", () => {
    const result = runBash(`
      API_HTTP_CODE="422"
      API_RESPONSE_BODY='{"error":"invalid_parameter"}'
      reason=$(_classify_api_result 0)
      if [[ -z "$reason" ]]; then echo "NO_RETRY"; else echo "RETRY:$reason"; fi
    `);
    expect(result.stdout).toBe("NO_RETRY");
  });
});
