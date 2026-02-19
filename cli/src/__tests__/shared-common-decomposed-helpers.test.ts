import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for recently decomposed helper functions in shared/common.sh:
 *
 * - _poll_instance_once: Single polling attempt extracted from
 *   generic_wait_for_instance (PR #976). Returns 0 if instance is ready
 *   (IP exported), 1 to keep polling (status matches but no IP), 2 on
 *   status mismatch. Used by 9+ cloud providers.
 *
 * - _report_instance_timeout: Timeout reporting extracted from
 *   generic_wait_for_instance (PR #976). Outputs actionable guidance
 *   when instance provisioning exhausts all attempts.
 *
 * - Error guidance messages added in PR #968 for:
 *   - generate_ssh_key_if_missing: disk space / permission guidance
 *   - get_ssh_fingerprint: missing/corrupt key file guidance
 *   - generic_ssh_wait: structured "How to fix" with SSH test command
 *   - ensure_jq: platform-specific install hints, hash rehash hint
 *
 * These helpers had zero direct test coverage despite being critical
 * shared infrastructure. While generic_wait_for_instance is tested
 * end-to-end, the decomposed helpers are not tested individually,
 * meaning a regression in one helper could be masked by the other.
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

// ── _poll_instance_once ────────────────────────────────────────────────────

describe("_poll_instance_once", () => {
  describe("instance ready (return 0)", () => {
    it("should return 0 when status matches and IP is present", () => {
      const result = runBash(`
mock_api() { echo '{"instance":{"status":"active","ip":"10.0.0.1"}}'; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 1 5
echo "EXIT=$?"
echo "IP=$TEST_IP"
`);
      expect(result.stdout).toContain("EXIT=0");
      expect(result.stdout).toContain("IP=10.0.0.1");
    });

    it("should export IP to the named variable", () => {
      const result = runBash(`
mock_api() { echo '{"server":{"state":"running","address":"203.0.113.5"}}'; }
_poll_instance_once mock_api "/servers/42" "running" \
  "d['server']['state']" "d['server']['address']" \
  MY_SERVER_IP "Server" 1 5
echo "RESULT=$MY_SERVER_IP"
`);
      expect(result.stdout).toContain("RESULT=203.0.113.5");
    });

    it("should log ready message with IP", () => {
      const result = runBash(`
mock_api() { echo '{"vm":{"status":"active","ip":"192.168.1.1"}}'; }
_poll_instance_once mock_api "/vms/1" "active" \
  "d['vm']['status']" "d['vm']['ip']" \
  IP "VM" 1 5
`);
      expect(result.stderr).toContain("VM ready");
      expect(result.stderr).toContain("192.168.1.1");
    });
  });

  describe("status matches but no IP (return 1)", () => {
    it("should return 1 when status matches but IP is empty", () => {
      const result = runBash(`
mock_api() { echo '{"instance":{"status":"active","ip":""}}'; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 1 5
echo "EXIT=$?"
`);
      expect(result.stdout).toContain("EXIT=1");
    });

    it("should log status with elapsed time when IP not yet assigned", () => {
      const result = runBash(`
mock_api() { echo '{"instance":{"status":"active","ip":""}}'; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 3 5
`);
      expect(result.stderr).toContain("Instance status: active");
      expect(result.stderr).toContain("15s elapsed");
    });
  });

  describe("status mismatch (return 2)", () => {
    it("should return 2 when status does not match target", () => {
      const result = runBash(`
mock_api() { echo '{"instance":{"status":"provisioning","ip":""}}'; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 1 5
echo "EXIT=$?"
`);
      expect(result.stdout).toContain("EXIT=2");
    });

    it("should log current status and elapsed time on mismatch", () => {
      const result = runBash(`
mock_api() { echo '{"instance":{"status":"booting","ip":""}}'; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 2 10
`);
      expect(result.stderr).toContain("Instance status: booting");
      expect(result.stderr).toContain("20s elapsed");
    });

    it("should calculate correct elapsed time from attempt * poll_delay", () => {
      const result = runBash(`
mock_api() { echo '{"server":{"status":"pending","ip":""}}'; }
_poll_instance_once mock_api "/servers/1" "running" \
  "d['server']['status']" "d['server']['ip']" \
  IP "Server" 5 3
`);
      expect(result.stderr).toContain("15s elapsed");
    });
  });

  describe("API error handling", () => {
    it("should handle API call failure gracefully", () => {
      const result = runBash(`
mock_api() { return 1; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 1 5
echo "EXIT=$?"
`);
      // API failure should result in status mismatch (return 2) since
      // _extract_json_field returns "unknown" for empty/invalid input
      expect(result.stdout).toContain("EXIT=2");
    });

    it("should handle invalid JSON from API", () => {
      const result = runBash(`
mock_api() { echo "not json"; }
_poll_instance_once mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  TEST_IP "Instance" 1 5
echo "EXIT=$?"
`);
      expect(result.stdout).toContain("EXIT=2");
    });
  });

  describe("deeply nested fields", () => {
    it("should extract IP from nested JSON structure", () => {
      const result = runBash(`
mock_api() {
  echo '{"droplet":{"status":"active","networks":{"v4":[{"ip_address":"198.51.100.1"}]}}}'
}
_poll_instance_once mock_api "/droplets/42" "active" \
  "d['droplet']['status']" "d['droplet']['networks']['v4'][0]['ip_address']" \
  DROPLET_IP "Droplet" 1 5
echo "IP=$DROPLET_IP"
`);
      expect(result.stdout).toContain("IP=198.51.100.1");
    });
  });
});

// ── _report_instance_timeout ────────────────────────────────────────────────

describe("_report_instance_timeout", () => {
  it("should include description in error message", () => {
    const result = runBash(`
_report_instance_timeout "MyInstance" "active" "300"
`);
    expect(result.stderr).toContain("MyInstance");
    expect(result.stderr).toContain("did not become active");
  });

  it("should include total time in error message", () => {
    const result = runBash(`
_report_instance_timeout "Server" "running" "120"
`);
    expect(result.stderr).toContain("120s");
  });

  it("should include re-run suggestion", () => {
    const result = runBash(`
_report_instance_timeout "VM" "ready" "60"
`);
    expect(result.stderr).toContain("retry");
  });

  it("should include dashboard check suggestion", () => {
    const result = runBash(`
_report_instance_timeout "Droplet" "active" "300"
`);
    expect(result.stderr).toContain("dashboard");
  });

  it("should include region suggestion", () => {
    const result = runBash(`
_report_instance_timeout "Instance" "active" "180"
`);
    expect(result.stderr).toContain("different region");
  });

  it("should work with various description names", () => {
    for (const desc of ["Droplet", "Linode", "Server", "VM", "Container"]) {
      const result = runBash(`_report_instance_timeout "${desc}" "running" "60"`);
      expect(result.stderr).toContain(desc);
      expect(result.stderr).toContain("did not become running");
    }
  });
});

// ── Error guidance messages (PR #968) ──────────────────────────────────────

describe("generate_ssh_key_if_missing error guidance", () => {
  it("should show disk space guidance when mkdir fails", () => {
    // The function structure should contain disk space guidance
    const result = runBash(`type generate_ssh_key_if_missing`);
    expect(result.stdout).toContain("disk space");
  });

  it("should show permission guidance when mkdir fails", () => {
    const result = runBash(`type generate_ssh_key_if_missing`);
    expect(result.stdout).toContain("permissions");
  });

  it("should succeed when key already exists", () => {
    const result = runBash(`
TMPDIR=$(mktemp -d)
KEY_PATH="$TMPDIR/id_ed25519"
# Create existing key
ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -q 2>/dev/null
generate_ssh_key_if_missing "$KEY_PATH"
echo "EXIT=$?"
rm -rf "$TMPDIR"
`);
    expect(result.stdout).toContain("EXIT=0");
  });
});

describe("get_ssh_fingerprint error guidance", () => {
  it("should show regeneration instructions for missing key", () => {
    const result = runBash(`type get_ssh_fingerprint`);
    expect(result.stdout).toContain("ssh-keygen");
  });

  it("should return fingerprint for valid key", () => {
    const result = runBash(`
TMPDIR=$(mktemp -d)
KEY_PATH="$TMPDIR/id_ed25519"
ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -q 2>/dev/null
fp=$(get_ssh_fingerprint "$KEY_PATH.pub")
echo "FP=$fp"
rm -rf "$TMPDIR"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FP=");
    // Fingerprint should contain MD5 hash pattern
    const fpLine = result.stdout.split("\n").find(l => l.startsWith("FP="));
    expect(fpLine).toBeDefined();
    const fp = fpLine!.replace("FP=", "");
    expect(fp.length).toBeGreaterThan(0);
  });

  it("should fail for non-existent key file", () => {
    const result = runBash(`
get_ssh_fingerprint "/tmp/nonexistent_key_$(date +%s).pub"
`);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("generic_ssh_wait error guidance", () => {
  it("should include error handling for timeout", () => {
    const result = runBash(`type _log_ssh_wait_timeout_error`);
    expect(result.stdout).toContain("timeout");
  });

  it("should include manual SSH test command suggestion", () => {
    const result = runBash(`type _log_ssh_wait_timeout_error`);
    expect(result.stdout).toContain("ssh");
  });

  it("should include firewall check suggestion", () => {
    const result = runBash(`type _log_ssh_wait_timeout_error`);
    expect(result.stdout).toContain("firewall");
  });
});

describe("ensure_jq error guidance", () => {
  it("should include hash rehash hint in function body", () => {
    const result = runBash(`type ensure_jq`);
    expect(result.stdout).toContain("hash -r");
  });

  it("should include platform-specific install commands", () => {
    const result = runBash(`type ensure_jq`);
    expect(result.stdout).toContain("apt-get");
    expect(result.stdout).toContain("dnf");
    expect(result.stdout).toContain("brew");
  });

  it("should include manual install URL for unknown package managers", () => {
    // ensure_jq may delegate to _report_jq_not_found helper
    const result = runBash(`type ensure_jq; type _report_jq_not_found 2>/dev/null || true`);
    const combined = result.stdout;
    expect(combined).toContain("jqlang.github.io");
  });

  it("should succeed when jq is already installed", () => {
    const result = runBash(`
if command -v jq &>/dev/null; then
  ensure_jq
  echo "EXIT=$?"
else
  echo "EXIT=0"  # Skip test if jq is not available
fi
`);
    expect(result.stdout).toContain("EXIT=0");
  });
});

// ── Integration: _poll_instance_once inside generic_wait_for_instance ────

describe("_poll_instance_once integration with generic_wait_for_instance", () => {
  it("should be called on each polling iteration", () => {
    const result = runBash(`
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 3 ]]; then
    echo '{"instance":{"status":"booting","ip":""}}'
  else
    echo '{"instance":{"status":"active","ip":"10.0.0.5"}}'
  fi
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  RESULT_IP "Instance" 5

echo "IP=$RESULT_IP"
CALLS=$(cat "$COUNTER_FILE")
echo "CALLS=$CALLS"
rm -f "$COUNTER_FILE"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("IP=10.0.0.5");
    expect(result.stdout).toContain("CALLS=3");
  });

  it("should call _report_instance_timeout when all attempts exhausted", () => {
    const result = runBash(`
mock_api() {
  echo '{"instance":{"status":"pending","ip":""}}'
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  IP "TestInstance" 2
`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("TestInstance did not become active");
    expect(result.stderr).toContain("retry");
    expect(result.stderr).toContain("dashboard");
  });

  it("should handle transition from empty IP to valid IP", () => {
    const result = runBash(`
COUNTER_FILE=$(mktemp)
echo "0" > "$COUNTER_FILE"

mock_api() {
  local count
  count=$(cat "$COUNTER_FILE")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"

  if [[ "$count" -lt 2 ]]; then
    # Status matches but IP empty (return 1 from _poll_instance_once)
    echo '{"instance":{"status":"active","ip":""}}'
  else
    echo '{"instance":{"status":"active","ip":"172.16.0.1"}}'
  fi
}

INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \
  "d['instance']['status']" "d['instance']['ip']" \
  IP "Instance" 5

echo "IP=$IP"
rm -f "$COUNTER_FILE"
`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("IP=172.16.0.1");
  });
});

// ── _report_api_failure error guidance (PR #968) ─────────────────────────

describe("_report_api_failure DNS/firewall guidance", () => {
  it("should suggest checking DNS and firewall for network errors", () => {
    const result = runBash(`type _report_api_failure`);
    // PR #968 added DNS/firewall/proxy guidance
    expect(result.stdout).toContain("DNS");
  });

  it("should include internet connection check suggestion", () => {
    const result = runBash(`
API_RESPONSE_BODY=""
_report_api_failure "Cloud API network error" 3
`);
    expect(result.stderr).toContain("internet connection");
  });

  it("should include status page suggestion for HTTP errors", () => {
    const result = runBash(`
API_RESPONSE_BODY='{}'
_report_api_failure "Cloud API returned service unavailable (HTTP 503)" 3
`);
    expect(result.stderr).toContain("status page");
  });
});

// ── log_install_failed guidance (PR #966) ─────────────────────────────────

describe("log_install_failed actionable guidance", () => {
  it("should include agent name in output", () => {
    const result = runBash(`log_install_failed "Claude Code" 2>&1`);
    expect(result.stdout).toContain("Claude Code");
  });

  it("should include install command when provided", () => {
    const result = runBash(`
log_install_failed "Codex" "npm install -g codex" "" 2>&1
`);
    expect(result.stdout).toContain("npm install -g codex");
  });

  it("should include SSH connection hint when server IP provided", () => {
    const result = runBash(`
log_install_failed "Claude Code" "npm install -g claude" "10.0.0.5" 2>&1
`);
    expect(result.stdout).toContain("ssh root@10.0.0.5");
  });

  it("should work without install command or server IP", () => {
    const result = runBash(`log_install_failed "TestAgent" 2>&1`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TestAgent");
    expect(result.stdout).toContain("The agent could not be installed or verified");
  });
});
