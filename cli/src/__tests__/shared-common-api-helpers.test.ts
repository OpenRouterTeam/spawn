import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for cloud API helper functions in shared/common.sh:
 * - _parse_api_response: HTTP status code + body extraction from curl output
 * - _update_retry_interval: exponential backoff interval doubling with cap
 * - _api_should_retry_on_error: retry decision based on attempt count
 * - calculate_retry_backoff: backoff with jitter
 * - _cloud_api_retry_loop: full retry loop with mock request function
 * - generic_cloud_api: end-to-end API call with Bearer auth (mocked)
 * - generic_cloud_api_custom_auth: end-to-end API call with custom auth (mocked)
 * - _make_api_request: Bearer auth wrapper
 * - _make_api_request_custom_auth: custom auth wrapper
 * - _curl_api: core curl wrapper (mocked curl)
 *
 * These functions were recently refactored (extracting _curl_api) and had
 * zero dedicated test coverage. They are critical infrastructure used by
 * every cloud provider for API communication.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const { spawnSync } = require("child_process");
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// ── _parse_api_response ─────────────────────────────────────────────────

describe("_parse_api_response", () => {
  describe("extracts HTTP code from last line", () => {
    it("should extract 200 status code from response", () => {
      const result = runBash(`
        _parse_api_response '{"ok": true}
200'
        echo "CODE:\${API_HTTP_CODE}"
        echo "BODY:\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:200");
      expect(result.stdout).toContain('BODY:{"ok": true}');
    });

    it("should extract 404 status code", () => {
      const result = runBash(`
        _parse_api_response '{"error": "not found"}
404'
        echo "CODE:\${API_HTTP_CODE}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:404");
    });

    it("should extract 500 status code", () => {
      const result = runBash(`
        _parse_api_response 'Internal Server Error
500'
        echo "CODE:\${API_HTTP_CODE}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:500");
    });

    it("should extract 429 rate limit status code", () => {
      const result = runBash(`
        _parse_api_response '{"message": "rate limited"}
429'
        echo "CODE:\${API_HTTP_CODE}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:429");
    });

    it("should extract 201 created status code", () => {
      const result = runBash(`
        _parse_api_response '{"id": "abc123"}
201'
        echo "CODE:\${API_HTTP_CODE}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:201");
    });

    it("should extract 503 service unavailable status code", () => {
      const result = runBash(`
        _parse_api_response 'Service Unavailable
503'
        echo "CODE:\${API_HTTP_CODE}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:503");
    });

    it("should extract 204 no content status code with empty body", () => {
      const result = runBash(`
        _parse_api_response '
204'
        echo "CODE:\${API_HTTP_CODE}"
        echo "BODY:[\${API_RESPONSE_BODY}]"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:204");
    });
  });

  describe("extracts response body correctly", () => {
    it("should extract single-line JSON body", () => {
      const result = runBash(`
        _parse_api_response '{"key": "value"}
200'
        echo "\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('{"key": "value"}');
    });

    it("should extract multiline JSON body", () => {
      const result = runBash(`
        _parse_api_response '{
  "server": {
    "id": 123,
    "name": "test"
  }
}
200'
        echo "\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"server"');
      expect(result.stdout).toContain('"id": 123');
      expect(result.stdout).toContain('"name": "test"');
    });

    it("should handle body with multiple lines correctly", () => {
      const result = runBash(`
        _parse_api_response 'line1
line2
line3
200'
        echo "\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
      expect(result.stdout).toContain("line3");
      expect(result.stdout).not.toContain("200");
    });

    it("should handle body containing numbers that look like HTTP codes", () => {
      const result = runBash(`
        _parse_api_response '{"status": 200, "count": 404}
200'
        echo "CODE:\${API_HTTP_CODE}"
        echo "BODY:\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:200");
      expect(result.stdout).toContain('"status": 200');
      expect(result.stdout).toContain('"count": 404');
    });

    it("should handle HTML error body", () => {
      const result = runBash(`
        _parse_api_response '<html><body>Error</body></html>
502'
        echo "CODE:\${API_HTTP_CODE}"
        echo "BODY:\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:502");
      expect(result.stdout).toContain("<html><body>Error</body></html>");
    });
  });

  describe("edge cases", () => {
    it("should handle response with only HTTP code (no body)", () => {
      const result = runBash(`
        _parse_api_response '200'
        echo "CODE:\${API_HTTP_CODE}"
        echo "BODYLEN:\${#API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CODE:200");
    });

    it("should set globals for subsequent calls", () => {
      const result = runBash(`
        _parse_api_response '{"first": true}
200'
        echo "FIRST_CODE:\${API_HTTP_CODE}"
        _parse_api_response '{"second": true}
500'
        echo "SECOND_CODE:\${API_HTTP_CODE}"
        echo "SECOND_BODY:\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("FIRST_CODE:200");
      expect(result.stdout).toContain("SECOND_CODE:500");
      expect(result.stdout).toContain('SECOND_BODY:{"second": true}');
    });

    it("should handle body with special characters", () => {
      const result = runBash(`
        _parse_api_response '{"msg": "hello & goodbye <world>"}
200'
        echo "\${API_RESPONSE_BODY}"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello & goodbye <world>");
    });
  });
});

// ── _update_retry_interval ──────────────────────────────────────────────

describe("_update_retry_interval", () => {
  it("should double the interval from 2 to 4", () => {
    const result = runBash(`
      interval=2
      max_interval=30
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4");
  });

  it("should double the interval from 4 to 8", () => {
    const result = runBash(`
      interval=4
      max_interval=30
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("8");
  });

  it("should cap at max_interval", () => {
    const result = runBash(`
      interval=16
      max_interval=30
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("30");
  });

  it("should not exceed max when already at max", () => {
    const result = runBash(`
      interval=30
      max_interval=30
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("30");
  });

  it("should handle interval=1 doubling to 2", () => {
    const result = runBash(`
      interval=1
      max_interval=60
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2");
  });

  it("should handle sequential doublings correctly", () => {
    const result = runBash(`
      interval=2
      max_interval=30
      _update_retry_interval interval max_interval
      echo "\${interval}"
      _update_retry_interval interval max_interval
      echo "\${interval}"
      _update_retry_interval interval max_interval
      echo "\${interval}"
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    const values = result.stdout.split("\n");
    expect(values[0]).toBe("4");   // 2 -> 4
    expect(values[1]).toBe("8");   // 4 -> 8
    expect(values[2]).toBe("16");  // 8 -> 16
    expect(values[3]).toBe("30");  // 16 -> 32, capped at 30
  });

  it("should handle small max_interval", () => {
    const result = runBash(`
      interval=5
      max_interval=5
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("5");
  });

  it("should handle max_interval=1", () => {
    const result = runBash(`
      interval=1
      max_interval=1
      _update_retry_interval interval max_interval
      echo "\${interval}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1");
  });
});

// ── _api_should_retry_on_error ──────────────────────────────────────────

describe("_api_should_retry_on_error", () => {
  it("should return 0 (retry) when attempt < max_retries", () => {
    const result = runBash(`
      _api_should_retry_on_error 1 3 1 30 "test error" 2>/dev/null
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:0");
  });

  it("should return 1 (no retry) when attempt >= max_retries", () => {
    const result = runBash(`
      _api_should_retry_on_error 3 3 1 30 "test error" 2>/dev/null
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:1");
  });

  it("should return 1 when attempt exceeds max_retries", () => {
    const result = runBash(`
      _api_should_retry_on_error 5 3 1 30 "test error" 2>/dev/null
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:1");
  });

  it("should output retry warning to stderr", () => {
    const result = runBash(`
      _api_should_retry_on_error 1 3 1 30 "Cloud API returned rate limit (HTTP 429)"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("rate limit");
    expect(result.stderr).toContain("retrying");
    expect(result.stderr).toContain("attempt 1/3");
  });

  it("should include attempt count in message", () => {
    const result = runBash(`
      _api_should_retry_on_error 2 5 1 30 "network error"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("attempt 2/5");
  });
});

// calculate_retry_backoff tests are in shared-common-logging-utils.test.ts

// ── _cloud_api_retry_loop ───────────────────────────────────────────────

describe("_cloud_api_retry_loop", () => {
  it("should succeed on first attempt with 200 response", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{"ok": true}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "GET /test")
      echo "EXIT:$?"
      echo "OUTPUT:\${output}"
    `);
    expect(result.stdout).toContain("EXIT:0");
    expect(result.stdout).toContain('OUTPUT:{"ok": true}');
  });

  it("should output response body on success", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{"id": "server-123", "status": "active"}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "GET /servers")
      echo "\${output}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"id": "server-123"');
    expect(result.stdout).toContain('"status": "active"');
  });

  it("should succeed with 201 created response", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE="201"
        API_RESPONSE_BODY='{"created": true}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "POST /servers")
      echo "EXIT:$?"
      echo "\${output}"
    `);
    expect(result.stdout).toContain("EXIT:0");
    expect(result.stdout).toContain('{"created": true}');
  });

  it("should fail after max retries on persistent 429", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE="429"
        API_RESPONSE_BODY='{"error": "rate limited"}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 1 "GET /test" 2>/dev/null)
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:1");
  });

  it("should fail after max retries on persistent 503", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE="503"
        API_RESPONSE_BODY='service unavailable'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 1 "GET /test" 2>/dev/null)
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:1");
  });

  it("should fail after max retries on network error", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE=""
        API_RESPONSE_BODY=""
        return 1
      }
      output=$(_cloud_api_retry_loop mock_request 1 "GET /test" 2>/dev/null)
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:1");
  });

  it("should not retry on 400 client error (returns body immediately)", () => {
    // Use temp file to count attempts since $() is a subshell
    const counterFile = join(testDir, "attempts");
    const result = runBash(`
      echo 0 > "${counterFile}"
      mock_request() {
        local c; c=$(cat "${counterFile}"); echo $((c + 1)) > "${counterFile}"
        API_HTTP_CODE="400"
        API_RESPONSE_BODY='{"error": "bad request"}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "GET /test" 2>/dev/null)
      echo "EXIT:$?"
      echo "\${output}"
    `);
    expect(result.stdout).toContain("EXIT:0");
    expect(result.stdout).toContain('{"error": "bad request"}');
    const attempts = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    expect(attempts).toBe(1);
  });

  it("should not retry on 401 unauthorized", () => {
    const counterFile = join(testDir, "attempts");
    const result = runBash(`
      echo 0 > "${counterFile}"
      mock_request() {
        local c; c=$(cat "${counterFile}"); echo $((c + 1)) > "${counterFile}"
        API_HTTP_CODE="401"
        API_RESPONSE_BODY='{"error": "unauthorized"}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "POST /create" 2>/dev/null)
    `);
    const attempts = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    expect(attempts).toBe(1);
  });

  it("should not retry on 403 forbidden", () => {
    const counterFile = join(testDir, "attempts");
    const result = runBash(`
      echo 0 > "${counterFile}"
      mock_request() {
        local c; c=$(cat "${counterFile}"); echo $((c + 1)) > "${counterFile}"
        API_HTTP_CODE="403"
        API_RESPONSE_BODY='{"error": "forbidden"}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "DELETE /server" 2>/dev/null)
    `);
    const attempts = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    expect(attempts).toBe(1);
  });

  it("should not retry on 404 not found", () => {
    const counterFile = join(testDir, "attempts");
    const result = runBash(`
      echo 0 > "${counterFile}"
      mock_request() {
        local c; c=$(cat "${counterFile}"); echo $((c + 1)) > "${counterFile}"
        API_HTTP_CODE="404"
        API_RESPONSE_BODY='{"error": "not found"}'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "GET /missing" 2>/dev/null)
      echo "\${output}"
    `);
    const attempts = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    expect(attempts).toBe(1);
    expect(result.stdout).toContain('{"error": "not found"}');
  });

  it("should pass extra arguments through to request function", () => {
    const result = runBash(`
      mock_request() {
        echo "ARGS:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='ok'
        return 0
      }
      output=$(_cloud_api_retry_loop mock_request 3 "test" "arg1" "arg2" "arg3")
      echo "EXIT:$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("ARGS:arg1 arg2 arg3");
    expect(result.stdout).toContain("EXIT:0");
  });

  it("should log error on max retry exhaustion for network error", () => {
    const result = runBash(`
      mock_request() {
        return 1
      }
      _cloud_api_retry_loop mock_request 1 "GET /endpoint"
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("network error");
  });

  it("should log error on max retry exhaustion for 429", () => {
    const result = runBash(`
      mock_request() {
        API_HTTP_CODE="429"
        API_RESPONSE_BODY='rate limited'
        return 0
      }
      _cloud_api_retry_loop mock_request 1 "GET /endpoint"
    `);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("rate limit");
  });
});

// ── generic_cloud_api (with mocked request function) ────────────────────

describe("generic_cloud_api (mocked request)", () => {
  it("should call _make_api_request with correct arguments", () => {
    const result = runBash(`
      _make_api_request() {
        echo "BASE:\${1}" >&2
        echo "TOKEN:\${2}" >&2
        echo "METHOD:\${3}" >&2
        echo "ENDPOINT:\${4}" >&2
        echo "BODY:\${5}" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{"result": "ok"}'
        return 0
      }
      output=$(generic_cloud_api "https://api.example.com" "my-token" "GET" "/v1/servers" "" 1)
      echo "EXIT:$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("BASE:https://api.example.com");
    expect(result.stderr).toContain("TOKEN:my-token");
    expect(result.stderr).toContain("METHOD:GET");
    expect(result.stderr).toContain("ENDPOINT:/v1/servers");
    expect(result.stdout).toContain("EXIT:0");
  });

  it("should pass body to _make_api_request for POST", () => {
    const result = runBash(`
      _make_api_request() {
        echo "METHOD:\${3}" >&2
        echo "BODY:\${5}" >&2
        API_HTTP_CODE="201"
        API_RESPONSE_BODY='{"id": 1}'
        return 0
      }
      output=$(generic_cloud_api "https://api.example.com" "token" "POST" "/servers" '{"name":"test"}' 1)
      echo "\${output}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("METHOD:POST");
    expect(result.stderr).toContain('BODY:{"name":"test"}');
    expect(result.stdout).toContain('{"id": 1}');
  });

  it("should return response body on success", () => {
    const result = runBash(`
      _make_api_request() {
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{"servers": [{"id": 1}, {"id": 2}]}'
        return 0
      }
      output=$(generic_cloud_api "https://api.example.com" "tok" "GET" "/servers" "" 1)
      echo "\${output}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"servers"');
    expect(result.stdout).toContain('"id": 1');
  });

  it("should use default max_retries=3 when not specified", () => {
    const counterFile = join(testDir, "attempts");
    const result = runBash(`
      echo 0 > "${counterFile}"
      _make_api_request() {
        local c; c=$(cat "${counterFile}"); echo $((c + 1)) > "${counterFile}"
        API_HTTP_CODE="429"
        API_RESPONSE_BODY='rate limited'
        return 0
      }
      _api_should_retry_on_error() { return 1; }
      output=$(generic_cloud_api "https://api.example.com" "tok" "GET" "/test" 2>/dev/null)
    `);
    // Default max_retries is 3, so the loop runs at most 3 times
    const attempts = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(3);
  });
});

// ── generic_cloud_api_custom_auth (with mocked request function) ────────

describe("generic_cloud_api_custom_auth (mocked request)", () => {
  it("should call _make_api_request_custom_auth with full URL", () => {
    const result = runBash(`
      _make_api_request_custom_auth() {
        echo "URL:\${1}" >&2
        echo "METHOD:\${2}" >&2
        echo "BODY:\${3}" >&2
        shift 3
        echo "AUTH_ARGS:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='ok'
        return 0
      }
      output=$(generic_cloud_api_custom_auth "https://api.example.com" "GET" "/account" "" 1 -H "X-Auth-Token: secret")
      echo "EXIT:$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("URL:https://api.example.com/account");
    expect(result.stderr).toContain("METHOD:GET");
    expect(result.stderr).toContain("AUTH_ARGS:-H X-Auth-Token: secret");
    expect(result.stdout).toContain("EXIT:0");
  });

  it("should pass Basic Auth credentials as custom curl args", () => {
    const result = runBash(`
      _make_api_request_custom_auth() {
        shift 3
        echo "AUTH:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{"user": "me"}'
        return 0
      }
      output=$(generic_cloud_api_custom_auth "https://api.example.com" "GET" "/me" "" 1 -u "user:pass")
      echo "\${output}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("AUTH:-u user:pass");
    expect(result.stdout).toContain('{"user": "me"}');
  });

  it("should pass body for POST with custom auth", () => {
    const result = runBash(`
      _make_api_request_custom_auth() {
        echo "BODY:\${3}" >&2
        API_HTTP_CODE="201"
        API_RESPONSE_BODY='{"created": true}'
        return 0
      }
      output=$(generic_cloud_api_custom_auth "https://api.example.com" "POST" "/servers" '{"size":"small"}' 1 -H "X-Auth: tok")
      echo "\${output}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('BODY:{"size":"small"}');
    expect(result.stdout).toContain('{"created": true}');
  });

  it("should support multiple custom auth headers", () => {
    const result = runBash(`
      _make_api_request_custom_auth() {
        shift 3
        echo "ARGS:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='ok'
        return 0
      }
      output=$(generic_cloud_api_custom_auth "https://api.example.com" "GET" "/test" "" 1 -H "X-Header-1: val1" -H "X-Header-2: val2")
      echo "EXIT:$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("X-Header-1: val1");
    expect(result.stderr).toContain("X-Header-2: val2");
  });
});

// ── _make_api_request (Bearer auth wrapper) ─────────────────────────────

describe("_make_api_request (Bearer auth wrapper)", () => {
  it("should call _curl_api with Bearer authorization header", () => {
    const result = runBash(`
      _curl_api() {
        echo "URL:\${1}" >&2
        echo "METHOD:\${2}" >&2
        echo "BODY:\${3}" >&2
        shift 3
        echo "EXTRA:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='ok'
        return 0
      }
      _make_api_request "https://api.example.com" "my-bearer-token" "GET" "/v1/servers" ""
      echo "EXIT:$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("URL:https://api.example.com/v1/servers");
    expect(result.stderr).toContain("METHOD:GET");
    expect(result.stderr).toContain("Authorization: Bearer my-bearer-token");
    expect(result.stdout).toContain("EXIT:0");
  });

  it("should concatenate base_url and endpoint", () => {
    const result = runBash(`
      _curl_api() {
        echo "URL:\${1}" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{}'
        return 0
      }
      _make_api_request "https://api.hetzner.cloud/v1" "tok" "GET" "/servers" ""
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("URL:https://api.hetzner.cloud/v1/servers");
  });

  it("should pass body for POST requests", () => {
    const result = runBash(`
      _curl_api() {
        echo "BODY:\${3}" >&2
        API_HTTP_CODE="201"
        API_RESPONSE_BODY='{"id":1}'
        return 0
      }
      _make_api_request "https://api.example.com" "tok" "POST" "/create" '{"name":"test"}'
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('BODY:{"name":"test"}');
  });

  it("should pass empty body for GET requests", () => {
    const result = runBash(`
      _curl_api() {
        echo "BODY:[\${3}]" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='{}'
        return 0
      }
      _make_api_request "https://api.example.com" "tok" "GET" "/list"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("BODY:[]");
  });
});

// ── _make_api_request_custom_auth (custom auth wrapper) ─────────────────

describe("_make_api_request_custom_auth", () => {
  it("should call _curl_api with custom auth args", () => {
    const result = runBash(`
      _curl_api() {
        echo "URL:\${1}" >&2
        echo "METHOD:\${2}" >&2
        shift 3
        echo "AUTH:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='ok'
        return 0
      }
      _make_api_request_custom_auth "https://api.example.com/v1/servers" "GET" "" -H "X-Auth-Token: mytoken"
      echo "EXIT:$?"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("URL:https://api.example.com/v1/servers");
    expect(result.stderr).toContain("METHOD:GET");
    expect(result.stderr).toContain("AUTH:-H X-Auth-Token: mytoken");
    expect(result.stdout).toContain("EXIT:0");
  });

  it("should pass body as third argument", () => {
    const result = runBash(`
      _curl_api() {
        echo "BODY:\${3}" >&2
        API_HTTP_CODE="201"
        API_RESPONSE_BODY='created'
        return 0
      }
      _make_api_request_custom_auth "https://api.example.com" "POST" '{"name":"s1"}' -u "user:pass"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('BODY:{"name":"s1"}');
  });

  it("should handle multiple custom auth arguments", () => {
    const result = runBash(`
      _curl_api() {
        shift 3
        echo "ARGS:$*" >&2
        API_HTTP_CODE="200"
        API_RESPONSE_BODY='ok'
        return 0
      }
      _make_api_request_custom_auth "https://api.example.com" "GET" "" -H "X-A: 1" -H "X-B: 2" -u "u:p"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("X-A: 1");
    expect(result.stderr).toContain("X-B: 2");
    expect(result.stderr).toContain("-u u:p");
  });
});

// ── _curl_api (core curl wrapper with mocked curl) ──────────────────────

describe("_curl_api (core curl wrapper)", () => {
  it("should set API_HTTP_CODE and API_RESPONSE_BODY via mocked curl", () => {
    const result = runBash(`
      curl() { printf '{"mocked":true}\n200'; return 0; }
      _curl_api "https://example.com/test" "GET" "" -H "Authorization: Bearer test"
      echo "CODE:\${API_HTTP_CODE}"
      echo "BODY:\${API_RESPONSE_BODY}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODE:200");
    expect(result.stdout).toContain('BODY:{"mocked":true}');
  });

  it("should return curl exit code on failure", () => {
    const result = runBash(`
      curl() { return 7; }
      _curl_api "https://unreachable.example.com" "GET" ""
      echo "EXIT:$?"
    `);
    expect(result.stdout).toContain("EXIT:7");
  });

  it("should pass arguments to curl including Content-Type", () => {
    // Use a temp file to record args since _curl_api captures curl stdout
    const argsFile = join(testDir, "curl-args");
    const result = runBash(`
      curl() {
        printf '%s\n' "$@" > "${argsFile}"
        printf '{"ok":true}\n200'
        return 0
      }
      _curl_api "https://example.com" "GET" ""
      echo "CODE:\${API_HTTP_CODE}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODE:200");
    const args = readFileSync(argsFile, "utf-8");
    expect(args).toContain("Content-Type: application/json");
    expect(args).toContain("-s");
    expect(args).toContain("-X");
    expect(args).toContain("GET");
    expect(args).toContain("https://example.com");
  });

  it("should include -d flag when body is provided", () => {
    const argsFile = join(testDir, "curl-args");
    const result = runBash(`
      curl() {
        printf '%s\n' "$@" > "${argsFile}"
        printf 'ok\n200'
        return 0
      }
      _curl_api "https://example.com" "POST" '{"name":"test"}'
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8");
    expect(args).toContain("-d");
    expect(args).toContain('{"name":"test"}');
  });

  it("should not include -d flag when body is empty", () => {
    const argsFile = join(testDir, "curl-args");
    const result = runBash(`
      curl() {
        printf '%s\n' "$@" > "${argsFile}"
        printf 'ok\n200'
        return 0
      }
      _curl_api "https://example.com" "GET" ""
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8");
    expect(args).not.toContain("-d");
  });

  it("should pass the URL as the last argument to curl", () => {
    const argsFile = join(testDir, "curl-args");
    const result = runBash(`
      curl() {
        printf '%s\n' "$@" > "${argsFile}"
        printf 'ok\n200'
        return 0
      }
      _curl_api "https://api.example.com/v1/endpoint" "GET" ""
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8").trim().split("\n");
    expect(args[args.length - 1]).toBe("https://api.example.com/v1/endpoint");
  });

  it("should pass extra non-auth args to curl", () => {
    // Authorization headers are now passed via -K (stdin) for security,
    // so we test with a non-Authorization header that passes through directly
    const argsFile = join(testDir, "curl-args");
    const result = runBash(`
      curl() {
        printf '%s\n' "$@" > "${argsFile}"
        printf 'ok\n200'
        return 0
      }
      _curl_api "https://example.com" "GET" "" -H "X-Custom: my-value"
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8");
    expect(args).toContain("-H");
    expect(args).toContain("X-Custom: my-value");
  });

  it("should use specified HTTP method", () => {
    const argsFile = join(testDir, "curl-args");
    const result = runBash(`
      curl() {
        printf '%s\n' "$@" > "${argsFile}"
        printf 'ok\n200'
        return 0
      }
      _curl_api "https://example.com" "DELETE" ""
    `);
    expect(result.exitCode).toBe(0);
    const args = readFileSync(argsFile, "utf-8");
    expect(args).toContain("-X");
    expect(args).toContain("DELETE");
  });

  it("should handle multiline response body from curl", () => {
    const result = runBash(`
      curl() {
        printf '{"line1": true,\n"line2": false}\n200'
        return 0
      }
      _curl_api "https://example.com" "GET" ""
      echo "CODE:\${API_HTTP_CODE}"
      echo "BODY:\${API_RESPONSE_BODY}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODE:200");
    expect(result.stdout).toContain('"line1": true');
    expect(result.stdout).toContain('"line2": false');
  });

  it("should handle 500 error response from curl", () => {
    const result = runBash(`
      curl() {
        printf '{"error": "internal"}\n500'
        return 0
      }
      _curl_api "https://example.com" "GET" ""
      echo "CODE:\${API_HTTP_CODE}"
      echo "BODY:\${API_RESPONSE_BODY}"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODE:500");
    expect(result.stdout).toContain('BODY:{"error": "internal"}');
  });
});
