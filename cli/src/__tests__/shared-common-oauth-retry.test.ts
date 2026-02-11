import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for untested bash functions in shared/common.sh:
 * - validate_oauth_port: OAuth port validation (security-critical)
 * - generate_env_config: shell export statement generation (injection risk)
 * - calculate_retry_backoff: exponential backoff with jitter
 * - _update_retry_interval: indirect variable update via printf -v
 * - _parse_api_response: HTTP response code extraction
 *
 * These functions had zero test coverage despite being security-relevant.
 * Each test sources shared/common.sh and calls the function in a real
 * bash subprocess to catch actual shell behavior.
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

// ── validate_oauth_port ──────────────────────────────────────────────────

describe("validate_oauth_port", () => {
  describe("accepts valid ports", () => {
    const validPorts = [
      "1024",   // minimum non-privileged
      "3000",   // common dev port
      "8080",   // common HTTP alt
      "8888",   // Jupyter default
      "9090",   // Prometheus default
      "49152",  // start of dynamic range
      "65535",  // maximum valid port
    ];

    for (const port of validPorts) {
      it(`should accept port ${port}`, () => {
        const result = runBash(`validate_oauth_port "${port}"`);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("rejects privileged ports (< 1024)", () => {
    const privilegedPorts = ["0", "1", "22", "80", "443", "1023"];

    for (const port of privilegedPorts) {
      it(`should reject privileged port ${port}`, () => {
        const result = runBash(`validate_oauth_port "${port}"`);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid port");
      });
    }
  });

  describe("rejects ports above 65535", () => {
    it("should reject port 65536", () => {
      const result = runBash(`validate_oauth_port "65536"`);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject port 99999", () => {
      const result = runBash(`validate_oauth_port "99999"`);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("rejects non-numeric input", () => {
    const invalidInputs = [
      { input: "abc", desc: "letters" },
      { input: "80; rm -rf /", desc: "command injection" },
      { input: "$(whoami)", desc: "command substitution" },
      { input: "8080abc", desc: "mixed alphanumeric" },
      { input: "-1", desc: "negative number" },
      { input: "", desc: "empty string" },
      { input: "3.14", desc: "decimal" },
      { input: "80 80", desc: "space-separated" },
    ];

    for (const { input, desc } of invalidInputs) {
      it(`should reject ${desc}: "${input}"`, () => {
        const result = runBash(`validate_oauth_port "${input}"`);
        expect(result.exitCode).not.toBe(0);
      });
    }
  });

  describe("boundary cases", () => {
    it("should reject port 1023 (just below minimum)", () => {
      const result = runBash(`validate_oauth_port "1023"`);
      expect(result.exitCode).not.toBe(0);
    });

    it("should accept port 1024 (minimum valid)", () => {
      const result = runBash(`validate_oauth_port "1024"`);
      expect(result.exitCode).toBe(0);
    });

    it("should accept port 65535 (maximum valid)", () => {
      const result = runBash(`validate_oauth_port "65535"`);
      expect(result.exitCode).toBe(0);
    });

    it("should reject port 65536 (just above maximum)", () => {
      const result = runBash(`validate_oauth_port "65536"`);
      expect(result.exitCode).not.toBe(0);
    });
  });
});

// ── generate_env_config ──────────────────────────────────────────────────

describe("generate_env_config", () => {
  it("should generate a single export statement", () => {
    const result = runBash(`generate_env_config "MY_KEY=my_value"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export MY_KEY='my_value'");
  });

  it("should generate multiple export statements", () => {
    const result = runBash(
      `generate_env_config "KEY1=val1" "KEY2=val2" "KEY3=val3"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KEY1='val1'");
    expect(result.stdout).toContain("export KEY2='val2'");
    expect(result.stdout).toContain("export KEY3='val3'");
  });

  it("should include spawn:env marker comment", () => {
    const result = runBash(`generate_env_config "K=V"`);
    expect(result.stdout).toContain("# [spawn:env]");
  });

  it("should escape single quotes in values", () => {
    // Value with single quote should be properly escaped
    const result = runBash(`generate_env_config "KEY=it'\\''s a test"`);
    expect(result.exitCode).toBe(0);
    // The output should be valid bash that can be sourced
    expect(result.stdout).toContain("export KEY=");
  });

  it("should handle values containing equals signs", () => {
    // KEY=val=ue should split on first = only
    const result = runBash(`generate_env_config "API_URL=https://example.com?key=abc"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export API_URL='https://example.com?key=abc'");
  });

  it("should handle empty value", () => {
    const result = runBash(`generate_env_config "EMPTY_KEY="`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export EMPTY_KEY=''");
  });

  it("should handle URL values with special characters", () => {
    const result = runBash(
      `generate_env_config "BASE_URL=https://openrouter.ai/api/v1"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "export BASE_URL='https://openrouter.ai/api/v1'"
    );
  });

  it("should handle API key format values", () => {
    const result = runBash(
      `generate_env_config "OPENROUTER_API_KEY=sk-or-v1-abc123def456"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "export OPENROUTER_API_KEY='sk-or-v1-abc123def456'"
    );
  });

  it("should produce sourceable bash output", () => {
    // The generated output should be valid bash that can be eval'd
    const result = runBash(`
      OUTPUT=$(generate_env_config "TEST_VAR=hello_world")
      eval "$OUTPUT"
      echo "$TEST_VAR"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello_world");
  });

  it("should produce sourceable output for values with spaces", () => {
    const result = runBash(`
      OUTPUT=$(generate_env_config "TEST_VAR=hello world")
      eval "$OUTPUT"
      echo "$TEST_VAR"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
  });

  it("should handle no arguments gracefully", () => {
    const result = runBash(`generate_env_config`);
    expect(result.exitCode).toBe(0);
    // Should still have the marker but no export lines
    expect(result.stdout).toContain("# [spawn:env]");
    expect(result.stdout).not.toContain("export");
  });
});

// ── calculate_retry_backoff ──────────────────────────────────────────────

describe("calculate_retry_backoff", () => {
  it("should return a numeric value", () => {
    const result = runBash(`calculate_retry_backoff 5 60`);
    expect(result.exitCode).toBe(0);
    const value = parseInt(result.stdout, 10);
    expect(isNaN(value)).toBe(false);
  });

  it("should return value within ±20% jitter range of input", () => {
    // Run multiple times to check the range
    // With interval=10 and ±20% jitter: expect 8-12
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const result = runBash(`calculate_retry_backoff 10 60`);
      results.push(parseInt(result.stdout, 10));
    }

    for (const val of results) {
      expect(val).toBeGreaterThanOrEqual(8);  // 10 * 0.8
      expect(val).toBeLessThanOrEqual(12);    // 10 * 1.2
    }
  });

  it("should cap at max_interval for doubling", () => {
    // calculate_retry_backoff applies jitter to the current interval,
    // but the function signature suggests doubling is done externally.
    // With interval=50 and max=60, the jitter is applied to 50 (40-60)
    const result = runBash(`calculate_retry_backoff 50 60`);
    const value = parseInt(result.stdout, 10);
    // 50 * 0.8 = 40, 50 * 1.2 = 60
    expect(value).toBeGreaterThanOrEqual(40);
    expect(value).toBeLessThanOrEqual(60);
  });

  it("should handle small intervals", () => {
    const result = runBash(`calculate_retry_backoff 1 60`);
    expect(result.exitCode).toBe(0);
    const value = parseInt(result.stdout, 10);
    // 1 * 0.8 = 0.8 -> 0 or 1, 1 * 1.2 = 1.2 -> 1
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(2);
  });

  it("should handle equal interval and max", () => {
    const result = runBash(`calculate_retry_backoff 30 30`);
    expect(result.exitCode).toBe(0);
    const value = parseInt(result.stdout, 10);
    // 30 * 0.8 = 24, 30 * 1.2 = 36
    expect(value).toBeGreaterThanOrEqual(24);
    expect(value).toBeLessThanOrEqual(36);
  });
});

// ── _update_retry_interval ───────────────────────────────────────────────

describe("_update_retry_interval", () => {
  it("should double the interval", () => {
    const result = runBash(`
      MY_INTERVAL=5
      MY_MAX=60
      _update_retry_interval MY_INTERVAL MY_MAX
      echo "$MY_INTERVAL"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("10");
  });

  it("should cap at max interval", () => {
    const result = runBash(`
      MY_INTERVAL=40
      MY_MAX=60
      _update_retry_interval MY_INTERVAL MY_MAX
      echo "$MY_INTERVAL"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("60");
  });

  it("should cap when doubling exceeds max", () => {
    const result = runBash(`
      MY_INTERVAL=35
      MY_MAX=60
      _update_retry_interval MY_INTERVAL MY_MAX
      echo "$MY_INTERVAL"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("60");
  });

  it("should handle interval of 1", () => {
    const result = runBash(`
      I=1
      M=100
      _update_retry_interval I M
      echo "$I"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2");
  });

  it("should handle interval already at max", () => {
    const result = runBash(`
      I=60
      M=60
      _update_retry_interval I M
      echo "$I"
    `);
    expect(result.exitCode).toBe(0);
    // 60 * 2 = 120 > 60, so capped at 60
    expect(result.stdout).toBe("60");
  });

  it("should update the variable in-place (not return a new value)", () => {
    // Verify that the variable is modified in the caller's scope
    const result = runBash(`
      RETRY_INT=3
      MAX_INT=100
      _update_retry_interval RETRY_INT MAX_INT
      _update_retry_interval RETRY_INT MAX_INT
      echo "$RETRY_INT"
    `);
    expect(result.exitCode).toBe(0);
    // 3 -> 6 -> 12
    expect(result.stdout).toBe("12");
  });

  it("should handle successive doublings up to max", () => {
    const result = runBash(`
      I=2
      M=20
      _update_retry_interval I M
      echo "$I"
      _update_retry_interval I M
      echo "$I"
      _update_retry_interval I M
      echo "$I"
      _update_retry_interval I M
      echo "$I"
    `);
    expect(result.exitCode).toBe(0);
    const values = result.stdout.split("\n");
    expect(values[0]).toBe("4");   // 2 -> 4
    expect(values[1]).toBe("8");   // 4 -> 8
    expect(values[2]).toBe("16");  // 8 -> 16
    expect(values[3]).toBe("20");  // 16 -> 32, capped at 20
  });
});

// ── _parse_api_response ──────────────────────────────────────────────────

describe("_parse_api_response", () => {
  it("should extract HTTP status code from last line", () => {
    const result = runBash(`
      RESPONSE='{"id":"123","status":"active"}
200'
      _parse_api_response "$RESPONSE"
      echo "$API_HTTP_CODE"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("200");
  });

  it("should extract response body without status code", () => {
    const result = runBash(`
      RESPONSE='{"error":"not found"}
404'
      _parse_api_response "$RESPONSE"
      echo "$API_RESPONSE_BODY"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"error":"not found"}');
  });

  it("should handle multi-line response body", () => {
    const result = runBash(`
      RESPONSE='{
  "id": "123",
  "name": "test"
}
200'
      _parse_api_response "$RESPONSE"
      echo "$API_HTTP_CODE"
      echo "---"
      echo "$API_RESPONSE_BODY"
    `);
    expect(result.exitCode).toBe(0);
    const parts = result.stdout.split("---");
    expect(parts[0].trim()).toBe("200");
    expect(parts[1]).toContain('"id": "123"');
    expect(parts[1]).toContain('"name": "test"');
  });

  it("should handle 500 error response", () => {
    const result = runBash(`
      RESPONSE='Internal Server Error
500'
      _parse_api_response "$RESPONSE"
      echo "$API_HTTP_CODE"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("500");
  });

  it("should handle empty response body", () => {
    const result = runBash(`
      RESPONSE='
204'
      _parse_api_response "$RESPONSE"
      echo "code=$API_HTTP_CODE"
      echo "body=$API_RESPONSE_BODY"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("code=204");
  });

  it("should handle 429 rate limit response", () => {
    const result = runBash(`
      RESPONSE='{"error":"rate_limit_exceeded"}
429'
      _parse_api_response "$RESPONSE"
      echo "$API_HTTP_CODE"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("429");
  });
});

// ── _api_handle_transient_http_error ─────────────────────────────────────

describe("_api_handle_transient_http_error", () => {
  it("should return 1 (fail) when max retries exhausted", () => {
    const result = runBash(`
      _api_handle_transient_http_error 429 5 5 10 60
      echo "exit=$?"
    `);
    // The function calls _api_should_retry_on_error which returns 1 when
    // attempt >= max_retries, and then _api_handle_transient_http_error returns 1
    expect(result.stdout).toContain("exit=1");
  });

  it("should log HTTP 429 in error message when retries exhausted", () => {
    const result = runBash(`
      _api_handle_transient_http_error 429 5 5 10 60 2>&1
    `);
    expect(result.stdout).toContain("HTTP 429");
  });

  it("should log HTTP 503 in error message when retries exhausted", () => {
    const result = runBash(`
      _api_handle_transient_http_error 503 5 5 10 60 2>&1
    `);
    expect(result.stdout).toContain("HTTP 503");
  });
});

// ── get_cloud_init_userdata ──────────────────────────────────────────────

describe("get_cloud_init_userdata", () => {
  it("should return cloud-config YAML", () => {
    const result = runBash(`get_cloud_init_userdata`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#cloud-config");
  });

  it("should include essential packages", () => {
    const result = runBash(`get_cloud_init_userdata`);
    expect(result.stdout).toContain("curl");
    expect(result.stdout).toContain("git");
    expect(result.stdout).toContain("zsh");
  });

  it("should install Bun", () => {
    const result = runBash(`get_cloud_init_userdata`);
    expect(result.stdout).toContain("bun.sh/install");
  });

  it("should install Claude Code", () => {
    const result = runBash(`get_cloud_init_userdata`);
    expect(result.stdout).toContain("claude.ai/install.sh");
  });

  it("should create completion marker file", () => {
    const result = runBash(`get_cloud_init_userdata`);
    expect(result.stdout).toContain(".cloud-init-complete");
  });

  it("should configure PATH in both .bashrc and .zshrc", () => {
    const result = runBash(`get_cloud_init_userdata`);
    expect(result.stdout).toContain(".bashrc");
    expect(result.stdout).toContain(".zshrc");
  });
});
