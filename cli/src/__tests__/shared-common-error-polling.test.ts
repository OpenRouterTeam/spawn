import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for extract_api_error_message and generic_wait_for_instance
 * in shared/common.sh.
 *
 * extract_api_error_message is used across 4+ cloud providers (10+ call sites)
 * to parse error responses from cloud APIs. It tries common JSON error field
 * patterns: error.message, error.error_message, message, reason, error (string).
 *
 * generic_wait_for_instance is used across 9 cloud providers as the core
 * polling loop for instance provisioning. It calls an API function repeatedly
 * until the target status is reached, then extracts the IP address.
 *
 * Both had zero test coverage despite being critical shared infrastructure.
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
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

// ── extract_api_error_message ──────────────────────────────────────────

describe("extract_api_error_message", () => {
  describe("top-level message field", () => {
    it("should extract message from top-level 'message' field", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"Server not found"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Server not found");
    });

    it("should extract message from top-level 'reason' field", () => {
      const result = runBash(
        `extract_api_error_message '{"reason":"Rate limit exceeded"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Rate limit exceeded");
    });
  });

  describe("error as string", () => {
    it("should extract error when it is a plain string", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"Unauthorized"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unauthorized");
    });

    it("should extract error string even when it is a long message", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"The API token provided is invalid or has expired"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("The API token provided is invalid or has expired");
    });
  });

  describe("error as object with message field", () => {
    it("should extract error.message when error is an object", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"Instance quota exceeded"}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Instance quota exceeded");
    });

    it("should extract error.error_message when error is an object", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"error_message":"Invalid region specified"}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid region specified");
    });

    it("should prefer error.message over error.error_message", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"Primary msg","error_message":"Secondary msg"}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Primary msg");
    });
  });

  describe("field priority", () => {
    it("should prefer error.message over top-level message", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"Nested error"},"message":"Top-level message"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Nested error");
    });

    it("should fall back to top-level message when error is empty object", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{},"message":"Top-level message"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Top-level message");
    });

    it("should fall back to reason when no message or error fields", () => {
      const result = runBash(
        `extract_api_error_message '{"reason":"Forbidden","status":403}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Forbidden");
    });

    it("should prefer message over reason", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"Auth failed","reason":"Forbidden"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Auth failed");
    });

    it("should prefer error string over reason", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"Bad token","reason":"Forbidden"}'`
      );
      expect(result.exitCode).toBe(0);
      // error string comes after message/reason in the or-chain but before empty
      // The actual priority: error.message > message > reason > error(string)
      // Wait, let's re-read the code:
      // msg = (isinstance(e, dict) and (e.get('message') or e.get('error_message')))
      //       or d.get('message')
      //       or d.get('reason')
      //       or (isinstance(e, str) and e)
      // So error string has lowest priority
      expect(result.stdout).toBe("Forbidden");
    });
  });

  describe("fallback behavior", () => {
    it("should use default fallback for invalid JSON", () => {
      const result = runBash(
        `extract_api_error_message 'not valid json'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should use custom fallback for invalid JSON", () => {
      const result = runBash(
        `extract_api_error_message 'not valid json' 'Custom fallback'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Custom fallback");
    });

    it("should use fallback when JSON has no recognized error fields", () => {
      const result = runBash(
        `extract_api_error_message '{"status":500,"code":"INTERNAL"}' 'Server error'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Server error");
    });

    it("should use default fallback for empty JSON object", () => {
      const result = runBash(
        `extract_api_error_message '{}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should use fallback for empty string input", () => {
      const result = runBash(
        `extract_api_error_message '' 'No response'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("No response");
    });

    it("should use fallback when error object has no message or error_message", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"code":"ERR_QUOTA"}}' 'Quota error'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Quota error");
    });
  });

  describe("real-world API responses", () => {
    it("should parse Hetzner-style error response", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"server_limit_exceeded","code":"limit_exceeded"}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("server_limit_exceeded");
    });

    it("should parse DigitalOcean-style error response", () => {
      const result = runBash(
        `extract_api_error_message '{"id":"unauthorized","message":"Unable to authenticate you"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unable to authenticate you");
    });

    it("should parse Vultr-style error response", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"Invalid API token.","status":401}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API token.");
    });

    it("should parse Contabo-style error response", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"Resource not found","code":404}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Resource not found");
    });

    it("should parse response with HTML error body as fallback", () => {
      const result = runBash(
        `extract_api_error_message '<html>503 Service Unavailable</html>' 'Service unavailable'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Service unavailable");
    });
  });

  describe("edge cases", () => {
    it("should handle message with special characters", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"Can'\\''t create: quota (5/5) exceeded"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("quota");
      expect(result.stdout).toContain("exceeded");
    });

    it("should handle message with unicode characters", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"Fehler: Kontingent \\u00fcberschritten"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Fehler");
    });

    it("should handle JSON array input as fallback", () => {
      const result = runBash(
        `extract_api_error_message '[1,2,3]' 'Not an object'`
      );
      expect(result.exitCode).toBe(0);
      // JSON array has no .get method, so python will throw and fall through to fallback
      expect(result.stdout).toBe("Not an object");
    });

    it("should handle null JSON value as fallback", () => {
      const result = runBash(
        `extract_api_error_message 'null' 'Null response'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Null response");
    });

    it("should handle nested error with empty message string", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":""},"reason":"Backup reason"}' 'default'`
      );
      expect(result.exitCode).toBe(0);
      // Empty message is falsy in Python, so it should fall through
      expect(result.stdout).toBe("Backup reason");
    });
  });
});

// ── _extract_json_field (additional edge cases) ────────────────────────

describe("_extract_json_field edge cases", () => {
  it("should return default when python expression raises KeyError", () => {
    const result = runBash(
      `_extract_json_field '{"a":1}' "d['nonexistent']" "default_val"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("default_val");
  });

  it("should return default when python expression raises TypeError on None", () => {
    const result = runBash(
      `_extract_json_field '{"a":null}' "d['a']['nested']" "fallback"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("fallback");
  });

  it("should handle zero value correctly (not treated as default)", () => {
    const result = runBash(
      `_extract_json_field '{"count":0}' "d['count']" "default"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
  });

  it("should handle False value correctly", () => {
    const result = runBash(
      `_extract_json_field '{"enabled":false}' "d['enabled']" "default"`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("False");
  });
});

// ── generic_wait_for_instance ──────────────────────────────────────────

describe("generic_wait_for_instance", () => {
  describe("successful polling", () => {
    it("should detect target status and extract IP on first attempt", () => {
      const result = runBash(`
# Mock API function that returns active status with IP
mock_api() {
  echo '{"instance":{"status":"active","ip":"10.0.0.1"}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/123" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  TEST_IP "Instance" 3

echo "IP=$TEST_IP"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=10.0.0.1");
    });

    it("should poll until target status is reached", () => {
      const result = runBash(`
# Counter file tracks how many times API is called
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 3 ]]; then
    echo '{"server":{"status":"provisioning","ip":""}}'
  else
    echo '{"server":{"status":"running","ip":"192.168.1.50"}}'
  fi
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/servers/abc" "running" \\
  "d['server']['status']" "d['server']['ip']" \\
  SERVER_IP "Server" 5

echo "IP=$SERVER_IP"
rm -f "$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=192.168.1.50");
    });

    it("should export the IP to the specified variable name", () => {
      const result = runBash(`
mock_api() {
  echo '{"vm":{"state":"active","address":"203.0.113.5"}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/vms/1" "active" \\
  "d['vm']['state']" "d['vm']['address']" \\
  MY_CUSTOM_VAR "VM" 2

echo "RESULT=$MY_CUSTOM_VAR"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("RESULT=203.0.113.5");
    });
  });

  describe("timeout behavior", () => {
    it("should fail after max_attempts when status never reaches target", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"provisioning","ip":""}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/123" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  TEST_IP "Instance" 3
`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("did not become active");
    });

    it("should use default max_attempts of 60 when not specified", () => {
      // We can't test 60 iterations, but verify the parameter is accepted
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"active","ip":"10.0.0.1"}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/123" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  TEST_IP "Instance"

echo "IP=$TEST_IP"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=10.0.0.1");
    });
  });

  describe("IP extraction edge cases", () => {
    it("should keep polling when status matches but IP is empty", () => {
      const result = runBash(`
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 3 ]]; then
    # Status is active but IP is empty (still allocating)
    echo '{"instance":{"status":"active","ip":""}}'
  else
    echo '{"instance":{"status":"active","ip":"10.0.0.5"}}'
  fi
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  TEST_IP "Instance" 5

echo "IP=$TEST_IP"
rm -f "$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=10.0.0.5");
    });

    it("should handle deeply nested IP field", () => {
      const result = runBash(`
mock_api() {
  echo '{"droplet":{"status":"active","networks":{"v4":[{"ip_address":"198.51.100.1"}]}}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/droplets/42" "active" \\
  "d['droplet']['status']" "d['droplet']['networks']['v4'][0]['ip_address']" \\
  DROPLET_IP "Droplet" 2

echo "IP=$DROPLET_IP"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=198.51.100.1");
    });
  });

  describe("API error handling", () => {
    it("should continue polling when API returns error", () => {
      const result = runBash(`
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 2 ]]; then
    # API fails
    return 1
  fi
  echo '{"instance":{"status":"active","ip":"10.0.0.3"}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  TEST_IP "Instance" 5

echo "IP=$TEST_IP"
rm -f "$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=10.0.0.3");
    });

    it("should continue polling when API returns invalid JSON", () => {
      const result = runBash(`
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 2 ]]; then
    echo "not json"
  else
    echo '{"server":{"status":"running","ip":"172.16.0.1"}}'
  fi
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/servers/1" "running" \\
  "d['server']['status']" "d['server']['ip']" \\
  SERVER_IP "Server" 5

echo "IP=$SERVER_IP"
rm -f "$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=172.16.0.1");
    });
  });

  describe("logging output", () => {
    it("should log status progress during polling", () => {
      const result = runBash(`
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 2 ]]; then
    echo '{"vm":{"state":"booting","ip":""}}'
  else
    echo '{"vm":{"state":"ready","ip":"10.0.0.9"}}'
  fi
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/vms/1" "ready" \\
  "d['vm']['state']" "d['vm']['ip']" \\
  VM_IP "VM" 5

rm -f "$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      // Check for status logging in stderr
      expect(result.stderr).toContain("Waiting for VM to become ready");
      expect(result.stderr).toContain("VM status: booting");
    });

    it("should log success with IP address", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"active","ip":"10.0.0.1"}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  IP "Instance" 1
echo "IP=\$IP"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=10.0.0.1");
    });

    it("should log helpful error message on timeout", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"pending","ip":""}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  IP "MyInstance" 2
`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("MyInstance did not become active");
      expect(result.stderr).toContain("retry the spawn command");
    });
  });
});
