import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";
import { readFileSync, unlinkSync } from "fs";

/**
 * Tests for extract_api_error_message, generic_wait_for_instance,
 * and verify_agent_installed in shared/common.sh.
 *
 * These three functions had zero dedicated test coverage despite being
 * used across all cloud provider scripts:
 *
 * - extract_api_error_message: Parses JSON API error responses from 10+ cloud
 *   providers. Tries common patterns: message, error, error.message,
 *   error.error_message, reason. Falls back to a configurable default.
 *
 * - generic_wait_for_instance: Polls a cloud API endpoint until an instance
 *   reaches target status and extracts the IP. Used by 12+ cloud providers.
 *
 * - verify_agent_installed: Checks that an agent binary is in PATH and
 *   responds to a verification argument (--version by default).
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 *
 * Uses a temp file to capture stderr on both success and failure,
 * since execSync only returns stdout on success.
 */
function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const stderrFile = `/tmp/spawn-test-stderr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const stdout = execSync(
      `bash -c '${fullScript.replace(/'/g, "'\\''")}'  2>"${stderrFile}"`,
      {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stderr = "";
    try { stderr = readFileSync(stderrFile, "utf-8"); } catch {}
    try { unlinkSync(stderrFile); } catch {}
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    let stderr = (err.stderr || "").trim();
    try { stderr = readFileSync(stderrFile, "utf-8").trim(); } catch {}
    try { unlinkSync(stderrFile); } catch {}
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

// ── extract_api_error_message ─────────────────────────────────────────────

describe("extract_api_error_message", () => {
  describe("top-level message field", () => {
    it("extracts top-level 'message' field (Hetzner/DO/Linode pattern)", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"Server limit exceeded"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Server limit exceeded");
    });

    it("extracts top-level 'reason' field (Scaleway/GCP pattern)", () => {
      const result = runBash(
        `extract_api_error_message '{"reason":"quota exceeded"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("quota exceeded");
    });
  });

  describe("error as string", () => {
    it("extracts 'error' when it is a string (simple pattern)", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"unauthorized"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unauthorized");
    });

    it("prefers top-level message over string error", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"short","message":"detailed message"}'`
      );
      expect(result.exitCode).toBe(0);
      // The logic: error is a string but message is checked first via d.get('message')
      expect(result.stdout).toBe("detailed message");
    });
  });

  describe("error as object (nested)", () => {
    it("extracts error.message (Vultr/DigitalOcean pattern)", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"Rate limit exceeded","code":429}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Rate limit exceeded");
    });

    it("extracts error.error_message (Contabo pattern)", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"error_message":"Invalid API key","status":401}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API key");
    });

    it("prefers error.message over error.error_message", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"primary","error_message":"fallback"}}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("primary");
    });
  });

  describe("priority order", () => {
    it("error.message takes priority over top-level message", () => {
      // error is a dict with 'message' -> that's checked first
      const result = runBash(
        `extract_api_error_message '{"error":{"message":"nested error"},"message":"top-level"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("nested error");
    });

    it("top-level message takes priority over reason", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"msg field","reason":"reason field"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("msg field");
    });

    it("reason takes priority over string error", () => {
      const result = runBash(
        `extract_api_error_message '{"error":"err","reason":"reason text"}'`
      );
      expect(result.exitCode).toBe(0);
      // The logic tries: error is a string (not dict), then d.get('message') (none),
      // then d.get('reason') => "reason text"
      expect(result.stdout).toBe("reason text");
    });
  });

  describe("fallback behavior", () => {
    it("uses default fallback for empty JSON object", () => {
      const result = runBash(`extract_api_error_message '{}'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("uses custom fallback for empty JSON object", () => {
      const result = runBash(
        `extract_api_error_message '{}' 'Custom fallback'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Custom fallback");
    });

    it("uses default fallback for invalid JSON", () => {
      const result = runBash(
        `extract_api_error_message 'not valid json at all'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("uses custom fallback for invalid JSON", () => {
      const result = runBash(
        `extract_api_error_message 'broken{json' 'Unable to parse'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unable to parse");
    });

    it("uses default fallback for empty string input", () => {
      const result = runBash(`extract_api_error_message ''`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("uses custom fallback when error is empty object", () => {
      const result = runBash(
        `extract_api_error_message '{"error":{}}' 'no message found'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("no message found");
    });
  });

  describe("real-world cloud provider error formats", () => {
    it("handles Hetzner error format", () => {
      const json = '{"error":{"message":"server_limit_exceeded","code":"uniqueness_error"}}';
      const result = runBash(`extract_api_error_message '${json}'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("server_limit_exceeded");
    });

    it("handles DigitalOcean error format", () => {
      const json = '{"id":"forbidden","message":"You do not have access for the attempted action."}';
      const result = runBash(`extract_api_error_message '${json}'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("You do not have access for the attempted action.");
    });

    it("handles Vultr error format", () => {
      const json = '{"error":"Invalid API token.","status":401}';
      const result = runBash(`extract_api_error_message '${json}'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API token.");
    });

    it("handles Linode error format", () => {
      const json = '{"errors":[{"reason":"Not found"}]}';
      // This doesn't match any of the patterns directly since 'errors' is an array
      // The fallback should be used
      const result = runBash(
        `extract_api_error_message '${json}' 'API error'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("API error");
    });

    it("handles Civo error format", () => {
      const json = '{"result":"error","reason":"Insufficient quota"}';
      const result = runBash(`extract_api_error_message '${json}'`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Insufficient quota");
    });
  });

  describe("edge cases", () => {
    it("handles JSON with unicode characters", () => {
      const result = runBash(
        `extract_api_error_message '{"message":"Fehler: Nicht gefunden"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Fehler");
    });

    it("handles JSON with numeric error code (not a string error)", () => {
      const result = runBash(
        `extract_api_error_message '{"error":500,"message":"Internal Server Error"}'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Internal Server Error");
    });

    it("handles JSON with null message field", () => {
      const result = runBash(
        `extract_api_error_message '{"message":null}' 'fallback'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fallback");
    });

    it("handles JSON with boolean error (not dict, not string)", () => {
      const result = runBash(
        `extract_api_error_message '{"error":true}' 'fallback'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fallback");
    });

    it("handles JSON array input (not an object)", () => {
      const result = runBash(
        `extract_api_error_message '[1,2,3]' 'not an object'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("not an object");
    });

    it("handles HTML error page (common from proxies)", () => {
      const result = runBash(
        `extract_api_error_message '<html>502 Bad Gateway</html>' 'server error'`
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("server error");
    });
  });
});

// ── generic_wait_for_instance ─────────────────────────────────────────────

describe("generic_wait_for_instance", () => {
  describe("successful polling", () => {
    it("returns 0 and exports IP when instance is immediately ready", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"active","ip":"10.0.0.1"}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/123" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_SERVER_IP "Test instance" 3
echo "IP=\${TEST_SERVER_IP}"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("IP=10.0.0.1");
    });

    it("polls until instance reaches target status", () => {
      const result = runBash(`
COUNTER_FILE=\$(mktemp)
echo 0 > "\$COUNTER_FILE"
mock_api() {
  local count=\$(cat "\$COUNTER_FILE")
  count=\$((count + 1))
  echo \$count > "\$COUNTER_FILE"
  if [[ \$count -lt 3 ]]; then
    echo '{"instance":{"status":"provisioning","ip":""}}'
  else
    echo '{"instance":{"status":"active","ip":"192.168.1.100"}}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/456" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  MY_IP "Server" 5
echo "RESULT_IP=\${MY_IP}"
rm -f "\$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("RESULT_IP=192.168.1.100");
    });
  });

  describe("timeout behavior", () => {
    it("returns 1 when max attempts exceeded", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"provisioning","ip":""}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/789" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  NEVER_SET "Instance" 2
`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("did not become active after 2 attempts");
    });

    it("shows retry guidance on timeout", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"starting","ip":""}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/i/1" "running" \
  "d['instance']['status']" "d['instance']['ip']" \
  NOPE "VM" 1
`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Re-run the command");
      expect(result.stderr).toContain("cloud provider dashboard");
      expect(result.stderr).toContain("different region");
    });
  });

  describe("status extraction patterns", () => {
    it("handles Vultr-style nested status", () => {
      const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"active","main_ip":"45.76.1.1"}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/v1" "active" \
  "d['instance']['status']" "d['instance']['main_ip']" \
  VULTR_IP "Vultr instance" 3
echo "GOT=\${VULTR_IP}"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=45.76.1.1");
    });

    it("handles DigitalOcean-style deeply nested IP", () => {
      const result = runBash(`
mock_api() {
  echo '{"droplet":{"status":"active","networks":{"v4":[{"ip_address":"159.65.1.1","type":"public"}]}}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/droplets/d1" "active" \
  "d['droplet']['status']" \
  "d['droplet']['networks']['v4'][0]['ip_address']" \
  DO_IP "Droplet" 3
echo "GOT=\${DO_IP}"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=159.65.1.1");
    });

    it("handles Linode-style flat IP", () => {
      const result = runBash(`
mock_api() {
  echo '{"status":"running","ipv4":["139.162.1.1"]}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/linode/instances/l1" "running" \
  "d['status']" "d['ipv4'][0]" \
  LINODE_IP "Linode" 3
echo "GOT=\${LINODE_IP}"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=139.162.1.1");
    });
  });

  describe("API error resilience", () => {
    it("continues polling when API returns invalid JSON", () => {
      const result = runBash(`
COUNTER_FILE=\$(mktemp)
echo 0 > "\$COUNTER_FILE"
mock_api() {
  local count=\$(cat "\$COUNTER_FILE")
  count=\$((count + 1))
  echo \$count > "\$COUNTER_FILE"
  if [[ \$count -eq 1 ]]; then
    echo 'not json'
  else
    echo '{"status":"active","ip":"10.10.10.10"}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/inst/1" "active" \
  "d['status']" "d['ip']" \
  RECOVERED_IP "Instance" 3
echo "GOT=\${RECOVERED_IP}"
rm -f "\$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=10.10.10.10");
    });

    it("continues polling when API returns empty response", () => {
      const result = runBash(`
COUNTER_FILE=\$(mktemp)
echo 0 > "\$COUNTER_FILE"
mock_api() {
  local count=\$(cat "\$COUNTER_FILE")
  count=\$((count + 1))
  echo \$count > "\$COUNTER_FILE"
  if [[ \$count -eq 1 ]]; then
    echo ''
  else
    echo '{"status":"active","ip":"1.2.3.4"}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/inst/2" "active" \
  "d['status']" "d['ip']" \
  EMPTY_IP "Instance" 3
echo "GOT=\${EMPTY_IP}"
rm -f "\$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=1.2.3.4");
    });

    it("continues polling when API function fails (exit code != 0)", () => {
      const result = runBash(`
COUNTER_FILE=\$(mktemp)
echo 0 > "\$COUNTER_FILE"
mock_api() {
  local count=\$(cat "\$COUNTER_FILE")
  count=\$((count + 1))
  echo \$count > "\$COUNTER_FILE"
  if [[ \$count -eq 1 ]]; then
    return 1
  else
    echo '{"status":"active","ip":"5.6.7.8"}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/inst/3" "active" \
  "d['status']" "d['ip']" \
  FAIL_IP "Instance" 3
echo "GOT=\${FAIL_IP}"
rm -f "\$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=5.6.7.8");
    });
  });

  describe("IP extraction edge cases", () => {
    it("continues polling when status matches but IP is empty", () => {
      const result = runBash(`
COUNTER_FILE=\$(mktemp)
echo 0 > "\$COUNTER_FILE"
mock_api() {
  local count=\$(cat "\$COUNTER_FILE")
  count=\$((count + 1))
  echo \$count > "\$COUNTER_FILE"
  if [[ \$count -lt 3 ]]; then
    echo '{"status":"active","ip":""}'
  else
    echo '{"status":"active","ip":"9.8.7.6"}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/inst/4" "active" \
  "d['status']" "d['ip']" \
  LATE_IP "Instance" 5
echo "GOT=\${LATE_IP}"
rm -f "\$COUNTER_FILE"
`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("GOT=9.8.7.6");
    });

    it("times out when status matches but IP never appears", () => {
      const result = runBash(`
mock_api() {
  echo '{"status":"active","ip":""}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/inst/5" "active" \
  "d['status']" "d['ip']" \
  MISSING_IP "Instance" 2
`);
      expect(result.exitCode).toBe(1);
    });
  });
});

// ── verify_agent_installed ────────────────────────────────────────────────

describe("verify_agent_installed", () => {
  it("returns 0 when agent command exists and responds to --version", () => {
    // 'bash' is always available and responds to --version
    const result = runBash(`verify_agent_installed bash --version "Bash"`);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("verified successfully");
  });

  it("returns 1 when agent command does not exist", () => {
    const result = runBash(`verify_agent_installed nonexistent_command_xyz123`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found in PATH");
  });

  it("uses --version as default verify argument", () => {
    // 'ls' exists but 'ls --version' works on Linux
    const result = runBash(`verify_agent_installed ls`);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("verified successfully");
  });

  it("uses agent_cmd as default agent_name", () => {
    const result = runBash(`verify_agent_installed nonexistent_cmd_abc`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nonexistent_cmd_abc");
  });

  it("uses custom agent_name in messages", () => {
    const result = runBash(
      `verify_agent_installed nonexistent_cmd_abc --version "My Custom Agent"`
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("My Custom Agent");
  });

  it("returns 1 when command exists but verify arg fails", () => {
    // 'true' command exists but 'true --invalid-flag-xyz' still returns 0
    // Use 'false' which always returns 1
    const result = runBash(`verify_agent_installed false --version "False Agent"`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("verification failed");
  });

  it("shows diagnostic suggestions on failure", () => {
    const result = runBash(`verify_agent_installed no_such_agent_xyz`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Re-run the script");
    expect(result.stderr).toContain("manually and ensure it is in PATH");
  });
});
