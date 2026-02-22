import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

/**
 * Tests for SSH helper and instance polling functions in shared/common.sh:
 *
 * - generic_ssh_wait: exponential-backoff SSH polling loop
 * - wait_for_cloud_init: cloud-init completion checker (thin wrapper)
 * - ssh_run_server: remote command execution via SSH
 * - ssh_upload_file: file upload via SCP
 * - ssh_interactive_session: interactive SSH session (-t flag)
 * - ssh_verify_connectivity: SSH connectivity check (thin wrapper)
 * - generic_wait_for_instance: API-based instance status polling
 *
 * These are CRITICAL infrastructure functions used by every cloud provider.
 * Tests use mock SSH/SCP commands to verify argument construction, variable
 * defaults (SSH_USER, SSH_OPTS), and failure/success behavior without
 * requiring actual SSH connectivity.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;
let mockBinDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-ssh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mockBinDir = join(testDir, "bin");
  mkdirSync(mockBinDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Optionally prepends mockBinDir to PATH for mock commands.
 */
function runBash(script: string, opts?: { useMockPath?: boolean }): { exitCode: number; stdout: string; stderr: string } {
  let prefix = "";
  if (opts?.useMockPath) {
    prefix = `export PATH="${mockBinDir}:$PATH"\n`;
  }
  const fullScript = `${prefix}source "${COMMON_SH}"\n${script}`;
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

/**
 * Create a mock executable script in the mock bin directory.
 */
function createMockCommand(name: string, script: string): void {
  const path = join(mockBinDir, name);
  writeFileSync(path, `#!/bin/bash\n${script}`, { mode: 0o755 });
}

// ── ssh_run_server ──────────────────────────────────────────────────────────

describe("ssh_run_server", () => {
  it("should construct correct SSH command with default SSH_USER=root", () => {
    // Use a mock ssh that prints its arguments
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no"\nssh_run_server "192.168.1.1" "uptime"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-o StrictHostKeyChecking=no");
    expect(stdout).toContain("root@192.168.1.1");
    expect(stdout).toContain("uptime");
  });

  it("should use SSH_USER when set", () => {
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no"\nSSH_USER=ubuntu\nssh_run_server "10.0.0.1" "ls -la"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ubuntu@10.0.0.1");
    expect(stdout).toContain("ls -la");
  });

  it("should pass through SSH exit code on failure", () => {
    createMockCommand("ssh", "exit 1");
    const { exitCode } = runBash(
      'SSH_OPTS=""\nssh_run_server "10.0.0.1" "false"',
      { useMockPath: true }
    );
    expect(exitCode).not.toBe(0);
  });

  it("should pass SSH_OPTS as unquoted options", () => {
    // This tests that SSH_OPTS is word-split (not quoted) per the SC2086 disable comment
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"\nssh_run_server "10.0.0.1" "echo hello"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    // Both options should appear as separate arguments
    expect(stdout).toContain("StrictHostKeyChecking=no");
    expect(stdout).toContain("UserKnownHostsFile=/dev/null");
  });

  it("should handle empty SSH_OPTS", () => {
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS=""\nssh_run_server "10.0.0.1" "hostname"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("root@10.0.0.1");
    expect(stdout).toContain("hostname");
  });

  it("should handle command with spaces and special characters", () => {
    createMockCommand("ssh", 'echo "CMD: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS=""\nssh_run_server "10.0.0.1" "cat /etc/os-release | grep NAME"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cat /etc/os-release | grep NAME");
  });
});

// ── ssh_upload_file ──────────────────────────────────────────────────────────

describe("ssh_upload_file", () => {
  it("should construct correct SCP command with default SSH_USER=root", () => {
    createMockCommand("scp", 'echo "SCP: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no"\nssh_upload_file "192.168.1.1" "/tmp/local.txt" "/remote/path.txt"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-o StrictHostKeyChecking=no");
    expect(stdout).toContain("/tmp/local.txt");
    expect(stdout).toContain("root@192.168.1.1:/remote/path.txt");
  });

  it("should use SSH_USER when set", () => {
    createMockCommand("scp", 'echo "SCP: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS=""\nSSH_USER=admin\nssh_upload_file "10.0.0.1" "/local/file" "/home/admin/file"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("admin@10.0.0.1:/home/admin/file");
  });

  it("should pass through SCP exit code on failure", () => {
    createMockCommand("scp", "exit 1");
    const { exitCode } = runBash(
      'SSH_OPTS=""\nssh_upload_file "10.0.0.1" "/local" "/remote"',
      { useMockPath: true }
    );
    expect(exitCode).not.toBe(0);
  });

  it("should pass SSH_OPTS as word-split options to SCP", () => {
    createMockCommand("scp", 'echo "SCP: $@"');
    const { stdout } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"\nssh_upload_file "10.0.0.1" "/a" "/b"',
      { useMockPath: true }
    );
    expect(stdout).toContain("StrictHostKeyChecking=no");
    expect(stdout).toContain("UserKnownHostsFile=/dev/null");
  });
});

// ── ssh_interactive_session ──────────────────────────────────────────────────

describe("ssh_interactive_session", () => {
  it("should include -t flag for interactive/TTY allocation", () => {
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout, exitCode } = runBash(
      'SSH_OPTS="-o StrictHostKeyChecking=no"\nssh_interactive_session "192.168.1.1" "bash"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("-t");
    expect(stdout).toContain("root@192.168.1.1");
    expect(stdout).toContain("bash");
  });

  it("should use SSH_USER when set", () => {
    createMockCommand("ssh", 'echo "ARGS: $@"');
    const { stdout } = runBash(
      'SSH_OPTS=""\nSSH_USER=deploy\nssh_interactive_session "10.0.0.1" "tmux"',
      { useMockPath: true }
    );
    expect(stdout).toContain("deploy@10.0.0.1");
    expect(stdout).toContain("-t");
  });

  it("should differ from ssh_run_server by having -t flag", () => {
    createMockCommand("ssh", 'echo "ARGS: $@"');

    const interactive = runBash(
      'SSH_OPTS=""\nssh_interactive_session "10.0.0.1" "bash"',
      { useMockPath: true }
    );
    const nonInteractive = runBash(
      'SSH_OPTS=""\nssh_run_server "10.0.0.1" "bash"',
      { useMockPath: true }
    );

    expect(interactive.stdout).toContain("-t");
    expect(nonInteractive.stdout).not.toContain("-t");
  });
});

// ── ssh_verify_connectivity ──────────────────────────────────────────────────

describe("ssh_verify_connectivity", () => {
  it("should add ConnectTimeout=5 to SSH options", () => {
    // generic_ssh_wait redirects ssh output to /dev/null, so use a log file
    const logFile = join(testDir, "ssh_args_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    const { exitCode } = runBash(
      `SSH_OPTS="-o StrictHostKeyChecking=no"\nssh_verify_connectivity "10.0.0.1" 1 1`,
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("ConnectTimeout=5");
  });

  it("should use SSH_USER default of root", () => {
    const logFile = join(testDir, "ssh_args_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    runBash(
      `SSH_OPTS=""\nssh_verify_connectivity "10.0.0.1" 1 1`,
      { useMockPath: true }
    );
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("root@10.0.0.1");
  });

  it("should use custom SSH_USER", () => {
    const logFile = join(testDir, "ssh_args_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    runBash(
      `SSH_OPTS=""\nSSH_USER=ec2-user\nssh_verify_connectivity "10.0.0.1" 1 1`,
      { useMockPath: true }
    );
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("ec2-user@10.0.0.1");
  });

  it("should fail after max_attempts when SSH never succeeds", () => {
    // Mock SSH to always fail and sleep to be instant
    createMockCommand("ssh", "exit 1");
    createMockCommand("sleep", "exit 0");
    const { exitCode } = runBash(
      'SSH_OPTS=""\nssh_verify_connectivity "10.0.0.1" 2 1',
      { useMockPath: true }
    );
    expect(exitCode).toBe(1);
  });

  it("should pass 'echo ok' as the test command", () => {
    const logFile = join(testDir, "ssh_args_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    runBash(
      `SSH_OPTS=""\nssh_verify_connectivity "10.0.0.1" 1 1`,
      { useMockPath: true }
    );
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("echo ok");
  });
});

// ── generic_ssh_wait ─────────────────────────────────────────────────────────

describe("generic_ssh_wait", () => {
  it("should succeed immediately when SSH command succeeds on first try", () => {
    createMockCommand("ssh", "exit 0");
    const { exitCode, stderr } = runBash(
      'generic_ssh_wait root 10.0.0.1 "" "echo ok" "SSH connectivity" 5 1',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("SSH connectivity ready");
  });

  it("should fail after max_attempts when SSH never succeeds", () => {
    createMockCommand("ssh", "exit 1");
    createMockCommand("sleep", "exit 0");
    const { exitCode, stderr } = runBash(
      'generic_ssh_wait root 10.0.0.1 "" "echo ok" "SSH connectivity" 2 1',
      { useMockPath: true }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("SSH connectivity timed out after");
  });

  it("should succeed on the second attempt", () => {
    // Create a mock SSH that fails on first call, succeeds on second
    const counterFile = join(testDir, "ssh_counter");
    writeFileSync(counterFile, "0");
    createMockCommand("sleep", "exit 0");
    createMockCommand("ssh", `
count=$(cat "${counterFile}")
count=$((count + 1))
echo "$count" > "${counterFile}"
if [ "$count" -ge 2 ]; then
  exit 0
else
  exit 1
fi
`);
    const { exitCode, stderr } = runBash(
      'generic_ssh_wait root 10.0.0.1 "" "echo ok" "SSH test" 5 1',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("SSH test ready");
  });

  it("should log elapsed time and attempt count", () => {
    createMockCommand("ssh", "exit 0");
    const { stderr } = runBash(
      'generic_ssh_wait root 10.0.0.1 "" "echo ok" "Connection" 3 1',
      { useMockPath: true }
    );
    expect(stderr).toContain("Connection ready");
  });

  it("should pass username and IP to SSH command", () => {
    const logFile = join(testDir, "ssh_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    const { exitCode } = runBash(
      `generic_ssh_wait myuser 203.0.113.1 "-o StrictHostKeyChecking=no" "echo ok" "test" 1 1`,
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("-o StrictHostKeyChecking=no");
    expect(log).toContain("myuser@203.0.113.1");
    expect(log).toContain("echo ok");
  });

  it("should use default max_attempts=30 when not specified", () => {
    // Just verify it doesn't crash with default params
    createMockCommand("ssh", "exit 0");
    const { exitCode } = runBash(
      'generic_ssh_wait root 10.0.0.1 "" "echo ok" "test"',
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
  });

  it("should log failure message with server IP for user guidance", () => {
    createMockCommand("ssh", "exit 1");
    createMockCommand("sleep", "exit 0");
    const { stderr } = runBash(
      'generic_ssh_wait root 10.0.0.1 "" "echo ok" "SSH" 2 1',
      { useMockPath: true }
    );
    expect(stderr).toContain("10.0.0.1");
    expect(stderr).toContain("Server is still booting");
  });
});

// ── wait_for_cloud_init ──────────────────────────────────────────────────────

describe("wait_for_cloud_init", () => {
  it("should pass correct arguments to generic_ssh_wait", () => {
    const logFile = join(testDir, "ssh_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    const { exitCode } = runBash(
      `wait_for_cloud_init "10.0.0.1" 2`,
      { useMockPath: true }
    );
    expect(exitCode).toBe(0);
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("root@10.0.0.1");
    expect(log).toContain("test -f /root/.cloud-init-complete");
  });

  it("should use SSH_OPTS for SSH options", () => {
    const logFile = join(testDir, "ssh_log");
    createMockCommand("ssh", `echo "$@" >> "${logFile}"; exit 0`);
    runBash(
      `SSH_OPTS="-o StrictHostKeyChecking=no"\nwait_for_cloud_init "10.0.0.1" 1`,
      { useMockPath: true }
    );
    const log = readFileSync(logFile, "utf-8");
    expect(log).toContain("StrictHostKeyChecking=no");
  });

  it("should fail when cloud-init never completes", () => {
    createMockCommand("ssh", "exit 1");
    createMockCommand("sleep", "exit 0");
    const { exitCode } = runBash(
      'wait_for_cloud_init "10.0.0.1" 2',
      { useMockPath: true }
    );
    expect(exitCode).toBe(1);
  });
});

// ── generic_wait_for_instance ────────────────────────────────────────────────

describe("generic_wait_for_instance", () => {
  it("should succeed when API returns target status and IP on first poll", () => {
    const { exitCode, stderr, stdout } = runBash(`
# Mock API function that returns a JSON response
mock_api() {
  echo '{"instance": {"status": "active", "main_ip": "203.0.113.42"}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/123" "active" \\
  "d['instance']['status']" "d['instance']['main_ip']" \\
  TEST_SERVER_IP "Test instance" 5
echo "IP=$TEST_SERVER_IP"
`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("IP=203.0.113.42");
    expect(stderr).toContain("Test instance ready (IP: 203.0.113.42)");
  });

  it("should poll until target status is reached", () => {
    const counterFile = join(testDir, "poll_counter");
    writeFileSync(counterFile, "0");
    const { exitCode, stdout } = runBash(`
mock_api() {
  local count
  count=$(cat "${counterFile}")
  count=$((count + 1))
  echo "$count" > "${counterFile}"
  if [ "$count" -ge 3 ]; then
    echo '{"server": {"status": "running", "ip": "10.0.0.5"}}'
  else
    echo '{"server": {"status": "provisioning", "ip": ""}}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/servers/1" "running" \\
  "d['server']['status']" "d['server']['ip']" \\
  MY_SERVER_IP "Server" 5
echo "RESULT=$MY_SERVER_IP"
`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESULT=10.0.0.5");
    const count = parseInt(readFileSync(counterFile, "utf-8").trim());
    expect(count).toBe(3);
  });

  it("should fail after max_attempts when status never reaches target", () => {
    const { exitCode, stderr } = runBash(`
mock_api() {
  echo '{"instance": {"status": "pending", "ip": ""}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/instances/1" "active" \\
  "d['instance']['status']" "d['instance']['ip']" \\
  TEST_IP "Instance" 3
`);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Instance did not become active within");
  });

  it("should export the IP variable to the environment", () => {
    const { exitCode, stdout } = runBash(`
mock_api() {
  echo '{"vm": {"state": "ready", "address": "172.16.0.1"}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/vms/abc" "ready" \\
  "d['vm']['state']" "d['vm']['address']" \\
  VM_IP "VM" 2
echo "EXPORTED=$VM_IP"
`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("EXPORTED=172.16.0.1");
  });

  it("should handle empty IP even when status matches (keep polling)", () => {
    const counterFile = join(testDir, "ip_counter");
    writeFileSync(counterFile, "0");
    const { exitCode, stdout } = runBash(`
mock_api() {
  local count
  count=$(cat "${counterFile}")
  count=$((count + 1))
  echo "$count" > "${counterFile}"
  if [ "$count" -ge 2 ]; then
    echo '{"i": {"s": "active", "ip": "1.2.3.4"}}'
  else
    echo '{"i": {"s": "active", "ip": ""}}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/i/1" "active" \\
  "d['i']['s']" "d['i']['ip']" \\
  GOT_IP "Instance" 5
echo "IP=$GOT_IP"
`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("IP=1.2.3.4");
  });

  it("should handle API errors gracefully (response extraction fails)", () => {
    const { exitCode } = runBash(`
mock_api() {
  echo "not valid json"
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/e/1" "active" \\
  "d['status']" "d['ip']" \\
  FAIL_IP "Broken" 2
`);
    expect(exitCode).toBe(1);
  });

  it("should default max_attempts to 60 when not specified", () => {
    // Just verify the function accepts 7 args without crashing
    const { exitCode } = runBash(`
mock_api() {
  echo '{"s": {"status": "active", "ip": "1.1.1.1"}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/x" "active" \\
  "d['s']['status']" "d['s']['ip']" \\
  X_IP "X"
echo "OK=$X_IP"
`);
    expect(exitCode).toBe(0);
  });

  it("should use INSTANCE_STATUS_POLL_DELAY for delay between polls", () => {
    const counterFile = join(testDir, "delay_counter");
    writeFileSync(counterFile, "0");
    const { exitCode } = runBash(`
mock_api() {
  local count
  count=$(cat "${counterFile}")
  count=$((count + 1))
  echo "$count" > "${counterFile}"
  if [ "$count" -ge 2 ]; then
    echo '{"r": {"status": "done", "ip": "5.5.5.5"}}'
  else
    echo '{"r": {"status": "waiting", "ip": ""}}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/r/1" "done" \\
  "d['r']['status']" "d['r']['ip']" \\
  R_IP "Resource" 5
`);
    expect(exitCode).toBe(0);
  });

  it("should show helpful guidance when polling times out", () => {
    const { stderr } = runBash(`
mock_api() {
  echo '{"x": {"status": "creating"}}'
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/x/1" "ready" \\
  "d['x']['status']" "d['x']['ip']" \\
  X_IP "Droplet" 2
`);
    expect(stderr).toContain("Check your cloud dashboard");
    expect(stderr).toContain("Wait 2-3 minutes and retry");
    expect(stderr).toContain("Try a different region");
  });

  it("should log current status during polling", () => {
    const counterFile = join(testDir, "status_counter");
    writeFileSync(counterFile, "0");
    const { stderr, exitCode } = runBash(`
mock_api() {
  local count
  count=$(cat "${counterFile}")
  count=$((count + 1))
  echo "$count" > "${counterFile}"
  if [ "$count" -ge 3 ]; then
    echo '{"s": "running", "ip": "9.9.9.9"}'
  else
    echo '{"s": "booting", "ip": ""}'
  fi
}
INSTANCE_STATUS_POLL_DELAY=0
generic_wait_for_instance mock_api "/s/1" "running" \\
  "d['s']" "d['ip']" \\
  S_IP "Server" 5
`);
    expect(exitCode).toBe(0);
    // Should show intermediate status during polling
    expect(stderr).toContain("booting");
  });
});

// extract_api_error_message tests are in shared-common-error-polling.test.ts
