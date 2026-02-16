import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for interactive input validation helpers in shared/common.sh:
 *
 * - get_resource_name: resource name from env var (bypassing safe_read)
 * - get_validated_server_name: env-var path + validate_server_name integration
 * - get_model_id_interactive: MODEL_ID env var path with validation
 * - interactive_pick: env var bypass path, list callback, default selection
 * - show_server_name_requirements: output format
 * - _display_and_select: menu rendering and default selection (non-stdin paths)
 * - validated_read: validation callback contract (via stdin workaround)
 *
 * These functions are used by every agent/cloud script but had zero test
 * coverage. Tests exercise the env-var bypass paths (most critical for
 * CI/automated usage) since safe_read requires an interactive terminal.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Always captures both stdout and stderr (even on success).
 */
function runBash(
  script: string,
  opts?: { env?: Record<string, string> }
): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const escaped = fullScript.replace(/'/g, "'\\''");
  try {
    const stdout = execSync(`bash -c '${escaped}' 2>/tmp/spawn-test-stderr$$`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...opts?.env },
    });
    let stderr = "";
    try {
      stderr = execSync(`cat /tmp/spawn-test-stderr$$ 2>/dev/null; rm -f /tmp/spawn-test-stderr$$`, {
        encoding: "utf-8",
      });
    } catch (err: any) {
      // Expected: cat fails if file doesn't exist. Log unexpected command failures.
      if (err.status !== 1) console.error("Unexpected error in stderr cleanup:", err);
    }
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    let stderr = (err.stderr || "").trim();
    try {
      const captured = execSync(`cat /tmp/spawn-test-stderr$$ 2>/dev/null; rm -f /tmp/spawn-test-stderr$$`, {
        encoding: "utf-8",
      });
      if (captured.trim()) stderr = captured.trim();
    } catch (captureErr: any) {
      // Expected: cat fails if file doesn't exist.
      if (captureErr.status !== 1) console.error("Unexpected error capturing stderr:", captureErr);
    }
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

/**
 * Run bash with stderr captured inline via fd redirection.
 * Captures both stdout and stderr reliably.
 */
function runBashCapture(
  script: string,
  opts?: { env?: Record<string, string> }
): { exitCode: number; stdout: string; stderr: string } {
  const stderrFile = `/tmp/spawn-test-err-${process.pid}-${Date.now()}`;
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const escaped = fullScript.replace(/'/g, "'\\''");
  try {
    const stdout = execSync(`bash -c '${escaped}' 2>"${stderrFile}"`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...opts?.env },
    });
    let stderr = "";
    try {
      stderr = execSync(`cat "${stderrFile}" 2>/dev/null`, { encoding: "utf-8" });
    } catch (err: any) {
      // Expected: cat fails if file doesn't exist.
      if (err.status !== 1) console.error("Unexpected error reading stderr file:", err);
    }
    try { execSync(`rm -f "${stderrFile}"`); } catch (err: any) {
      console.error("Unexpected error removing stderr file:", err);
    }
    return { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    let stderr = (err.stderr || "").trim();
    try {
      const captured = execSync(`cat "${stderrFile}" 2>/dev/null`, { encoding: "utf-8" });
      if (captured.trim()) stderr = captured.trim();
    } catch (captureErr: any) {
      // Expected: cat fails if file doesn't exist.
      if (captureErr.status !== 1) console.error("Unexpected error capturing stderr:", captureErr);
    }
    try { execSync(`rm -f "${stderrFile}"`); } catch (rmErr: any) {
      console.error("Unexpected error removing stderr file:", rmErr);
    }
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout || "").trim(),
      stderr,
    };
  }
}

// ── get_resource_name (env var path) ───────────────────────────────────────

describe("get_resource_name", () => {
  describe("env var set (bypasses stdin)", () => {
    it("should return value from env var", () => {
      const result = runBash(
        'get_resource_name "MY_RESOURCE" "Enter resource name: "',
        { env: { MY_RESOURCE: "from-env" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("from-env");
    });

    it("should log that value comes from environment", () => {
      const result = runBashCapture(
        'get_resource_name "MY_SERVER" "Enter server name: "',
        { env: { MY_SERVER: "test-srv" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("environment");
    });

    it("should accept hyphenated names", () => {
      const result = runBash(
        'get_resource_name "NAME" "Enter: "',
        { env: { NAME: "my-server-01" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("my-server-01");
    });

    it("should accept names with underscores", () => {
      const result = runBash(
        'get_resource_name "NAME" "Enter: "',
        { env: { NAME: "my_server" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("my_server");
    });

    it("should accept names with dots", () => {
      const result = runBash(
        'get_resource_name "TYPE" "Enter: "',
        { env: { TYPE: "e2.micro" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("e2.micro");
    });

    it("should preserve spaces in env var value", () => {
      const result = runBash(
        'get_resource_name "LABEL" "Enter: "',
        { env: { LABEL: "My Server Label" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("My Server Label");
    });
  });

  describe("env var not set (stdin path fails without tty)", () => {
    it("should fail in non-interactive mode with empty env var", () => {
      const result = runBash(
        'get_resource_name "UNSET_VAR_XYZ" "Enter name: "',
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should show error about non-interactive mode", () => {
      const result = runBashCapture(
        'get_resource_name "UNSET_VAR_XYZ" "Enter name: "',
      );
      expect(result.exitCode).not.toBe(0);
      // Should mention the env var name users can set
      expect(result.stderr).toContain("UNSET_VAR_XYZ");
    });
  });
});

// ── get_validated_server_name (env var + validation) ───────────────────────

describe("get_validated_server_name", () => {
  describe("valid server names from env var", () => {
    it("should accept valid name", () => {
      const result = runBash(
        'get_validated_server_name "SERVER_NAME" "Enter name: "',
        { env: { SERVER_NAME: "my-server-01" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("my-server-01");
    });

    it("should accept 3-char name (minimum length)", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "abc" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("abc");
    });

    it("should accept 63-char name (maximum length)", () => {
      const longName = "a".repeat(63);
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: longName } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(longName);
    });

    it("should accept all-numeric name", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "12345" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("12345");
    });

    it("should accept mixed case name", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "MyServer01" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("MyServer01");
    });

    it("should accept name with interior dashes", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "a-b-c" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a-b-c");
    });
  });

  describe("invalid server names rejected from env var", () => {
    it("should reject name shorter than 3 chars", () => {
      const result = runBashCapture(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "ab" } }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("too short");
    });

    it("should reject single character name", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "x" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name longer than 63 chars", () => {
      const longName = "a".repeat(64);
      const result = runBashCapture(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: longName } }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("too long");
    });

    it("should reject name with special characters", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "server;rm" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name starting with dash", () => {
      const result = runBashCapture(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "-server" } }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("dash");
    });

    it("should reject name ending with dash", () => {
      const result = runBashCapture(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "server-" } }
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("dash");
    });

    it("should reject name with underscores", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "my_server" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with spaces", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "my server" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with dots", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "my.server" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject empty name", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject injection attempt with semicolons", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "test;whoami" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject injection attempt with backticks", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "test`id`" } }
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject path traversal attempt", () => {
      const result = runBash(
        'get_validated_server_name "NAME" "Enter: "',
        { env: { NAME: "../../../etc" } }
      );
      expect(result.exitCode).not.toBe(0);
    });
  });
});

// ── get_model_id_interactive ───────────────────────────────────────────────

describe("get_model_id_interactive", () => {
  describe("MODEL_ID env var set (bypasses stdin)", () => {
    it("should return MODEL_ID from env var", () => {
      const result = runBash('get_model_id_interactive "openrouter/auto" "Aider"', {
        env: { MODEL_ID: "anthropic/claude-3.5-sonnet" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("anthropic/claude-3.5-sonnet");
    });

    it("should accept simple model ID", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "openrouter/auto" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("openrouter/auto");
    });

    it("should accept model ID with version numbers", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "anthropic/claude-3.5-sonnet-20241022" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("anthropic/claude-3.5-sonnet-20241022");
    });

    it("should accept model ID with dots", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "google/gemini-1.5-pro" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("google/gemini-1.5-pro");
    });

    it("should accept model ID with colons", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "anthropic/claude-3.5-sonnet:beta" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("anthropic/claude-3.5-sonnet:beta");
    });
  });

  describe("MODEL_ID env var validation failures", () => {
    it("should reject MODEL_ID with semicolons (injection)", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "model;rm -rf /" },
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject MODEL_ID with backticks (injection)", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "model`whoami`" },
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject MODEL_ID with dollar-paren (injection)", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "$(whoami)/model" },
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject MODEL_ID with pipe (injection)", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "model|cat /etc/passwd" },
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject MODEL_ID with ampersand (injection)", () => {
      const result = runBash('get_model_id_interactive', {
        env: { MODEL_ID: "model&whoami" },
      });
      expect(result.exitCode).not.toBe(0);
    });

    it("should show error about invalid characters", () => {
      const result = runBashCapture('get_model_id_interactive', {
        env: { MODEL_ID: "bad;model" },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("invalid");
    });
  });

  describe("MODEL_ID not set (falls through to stdin)", () => {
    it("should use default model in non-interactive mode without MODEL_ID", () => {
      const result = runBash(
        'get_model_id_interactive "openrouter/auto" "Aider"',
      );
      // Falls through to safe_read which fails without tty,
      // but the function catches this and uses the default model
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("openrouter/auto");
    });

    it("should show model browsing hint before prompting", () => {
      const result = runBashCapture(
        'get_model_id_interactive "openrouter/auto" "TestAgent"',
      );
      expect(result.stderr).toContain("openrouter.ai/models");
    });

    it("should show agent name in prompt text", () => {
      const result = runBashCapture(
        'get_model_id_interactive "openrouter/auto" "Aider"',
      );
      expect(result.stderr).toContain("Aider");
    });
  });
});

// ── interactive_pick (env var bypass) ──────────────────────────────────────

describe("interactive_pick", () => {
  describe("env var bypass (most common non-interactive path)", () => {
    it("should return env var value without calling list callback", () => {
      const result = runBash(
        'interactive_pick "HETZNER_LOCATION" "fsn1" "locations" "echo should-not-see-this"',
        { env: { HETZNER_LOCATION: "nbg1" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("nbg1");
      // The list callback output should NOT appear since env var takes priority
      expect(result.stdout).not.toContain("should-not-see-this");
    });

    it("should return env var for arbitrary values", () => {
      const result = runBash(
        'interactive_pick "MY_ZONE" "us-east-1" "zones" "echo dummy"',
        { env: { MY_ZONE: "eu-west-2" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("eu-west-2");
    });

    it("should accept hyphenated env var values", () => {
      const result = runBash(
        'interactive_pick "SERVER_TYPE" "cpx11" "types" "echo unused"',
        { env: { SERVER_TYPE: "cpx21" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("cpx21");
    });

    it("should accept env var with multiple words", () => {
      const result = runBash(
        'interactive_pick "IMAGE_NAME" "ubuntu-22.04" "images" "echo unused"',
        { env: { IMAGE_NAME: "debian-12" } }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("debian-12");
    });
  });

  describe("env var not set: list callback runs", () => {
    it("should use default when list callback returns empty", () => {
      const result = runBash(
        'no_items() { true; }; interactive_pick "UNSET_XYZ" "default-val" "regions" "no_items"',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("default-val");
    });

    it("should warn about using default when list is empty", () => {
      const result = runBashCapture(
        'no_items() { true; }; interactive_pick "UNSET_XYZ" "fallback" "items" "no_items"',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("default");
    });

    it("should use default even when list callback fails", () => {
      const result = runBash(
        'failing_list() { return 1; }; interactive_pick "UNSET_XYZ" "safe-default" "zones" "failing_list"',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("safe-default");
    });
  });
});

// ── show_server_name_requirements ──────────────────────────────────────────

describe("show_server_name_requirements", () => {
  it("should output requirements mentioning character range", () => {
    const result = runBashCapture("show_server_name_requirements");
    expect(result.stderr).toContain("3-63");
  });

  it("should mention alphanumeric characters", () => {
    const result = runBashCapture("show_server_name_requirements");
    expect(result.stderr).toContain("letters");
    expect(result.stderr).toContain("numbers");
  });

  it("should mention dash restriction", () => {
    const result = runBashCapture("show_server_name_requirements");
    expect(result.stderr).toContain("dash");
  });
});

// ── _display_and_select (rendering, not stdin) ─────────────────────────────

describe("_display_and_select", () => {
  describe("menu rendering to stderr", () => {
    it("should display numbered items", () => {
      // Will fail on safe_read (no tty) but should still render the menu
      const result = runBashCapture(
        '_display_and_select "locations" "fsn1" "" <<< "fsn1|Falkenstein|DE\nnbg1|Nuremberg|DE"',
      );
      expect(result.stderr).toContain("1)");
      expect(result.stderr).toContain("2)");
      expect(result.stderr).toContain("fsn1");
      expect(result.stderr).toContain("nbg1");
    });

    it("should display Available heading with prompt text", () => {
      const result = runBashCapture(
        '_display_and_select "server types" "cpx11" "" <<< "cpx11|2 vCPU|4 GB"',
      );
      expect(result.stderr).toContain("Available server types");
    });

    it("should handle single-item list", () => {
      const result = runBashCapture(
        '_display_and_select "zones" "zone1" "" <<< "zone1|Zone One"',
      );
      expect(result.stderr).toContain("1)");
      expect(result.stderr).toContain("zone1");
    });

    it("should handle many items", () => {
      // Build a list of 10 items using printf to get real newlines
      const items = Array.from({ length: 10 }, (_, i) => `item${i}|Item ${i}`).join("\\n");
      const result = runBashCapture(
        `_display_and_select "options" "item0" "" <<< "$(printf "${items}")"`,
      );
      expect(result.stderr).toContain("1)");
      expect(result.stderr).toContain("10)");
    });
  });

  describe("default value on stdin failure", () => {
    it("should output default value when safe_read fails", () => {
      // In non-tty mode, safe_read fails, so _display_and_select
      // uses the default value (first item index as default)
      const result = runBash(
        '_display_and_select "locations" "fsn1" "" <<< "fsn1|Falkenstein\nnbg1|Nuremberg"',
      );
      // It falls back to default when stdin is unavailable
      expect(result.stdout).toBe("fsn1");
    });
  });
});

// ── validated_read contract tests ──────────────────────────────────────────
// These test the validator callback contract without needing stdin,
// by verifying what validated_read would accept/reject through
// the validators themselves.

describe("validated_read validator contract", () => {
  describe("validate_api_token accepts valid tokens", () => {
    it("should accept standard API key format", () => {
      const result = runBash('validate_api_token "sk-or-v1-abc123def456" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should accept token with underscores", () => {
      const result = runBash('validate_api_token "my_api_token_123" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should accept token with dots", () => {
      const result = runBash('validate_api_token "token.with.dots" && echo OK');
      expect(result.stdout).toBe("OK");
    });
  });

  describe("validate_api_token rejects dangerous tokens", () => {
    it("should reject token with semicolons", () => {
      const result = runBash('validate_api_token "token;injection"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject token with single quotes", () => {
      const result = runBash("validate_api_token \"token'inject\"");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject token with double quotes", () => {
      const result = runBash('validate_api_token "token\\"inject"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject token with dollar sign", () => {
      const result = runBash('validate_api_token "token\\$inject"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject token with pipe", () => {
      const result = runBash('validate_api_token "token|cmd"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject token with ampersand", () => {
      const result = runBash('validate_api_token "token&bg"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject empty token", () => {
      const result = runBash('validate_api_token ""');
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("validate_region_name via validated_read contract", () => {
    it("should accept standard AWS-style region", () => {
      const result = runBash('validate_region_name "us-east-1" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should accept region with underscores", () => {
      const result = runBash('validate_region_name "eu_west_1" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should accept single-word region", () => {
      const result = runBash('validate_region_name "london" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should reject region with spaces", () => {
      const result = runBash('validate_region_name "us east 1"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject region longer than 63 chars", () => {
      const longRegion = "a".repeat(64);
      const result = runBash(`validate_region_name "${longRegion}"`);
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject empty region", () => {
      const result = runBash('validate_region_name ""');
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("validate_resource_name via validated_read contract", () => {
    it("should accept resource name with dots", () => {
      const result = runBash('validate_resource_name "e2.micro" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should accept resource name with underscores and hyphens", () => {
      const result = runBash('validate_resource_name "cx11_ssd-fast" && echo OK');
      expect(result.stdout).toBe("OK");
    });

    it("should reject resource name with semicolons", () => {
      const result = runBash('validate_resource_name "type;injection"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject resource name with spaces", () => {
      const result = runBash('validate_resource_name "big server"');
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject empty resource name", () => {
      const result = runBash('validate_resource_name ""');
      expect(result.exitCode).not.toBe(0);
    });
  });
});

// ── Integration: get_validated_server_name boundary tests ──────────────────

describe("get_validated_server_name boundaries", () => {
  it("should accept exactly 3 characters (boundary)", () => {
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: "abc" } }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abc");
  });

  it("should reject exactly 2 characters (below boundary)", () => {
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: "ab" } }
    );
    expect(result.exitCode).not.toBe(0);
  });

  it("should accept exactly 63 characters (boundary)", () => {
    const name = "a".repeat(63);
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: name } }
    );
    expect(result.exitCode).toBe(0);
  });

  it("should reject exactly 64 characters (above boundary)", () => {
    const name = "a".repeat(64);
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: name } }
    );
    expect(result.exitCode).not.toBe(0);
  });

  it("should accept name with dash in middle", () => {
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: "a-b" } }
    );
    expect(result.exitCode).toBe(0);
  });

  it("should reject name that is only dashes", () => {
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: "---" } }
    );
    expect(result.exitCode).not.toBe(0);
  });

  it("should reject name starting and ending with dashes", () => {
    const result = runBash(
      'get_validated_server_name "N" "Enter: "',
      { env: { N: "-abc-" } }
    );
    expect(result.exitCode).not.toBe(0);
  });
});
