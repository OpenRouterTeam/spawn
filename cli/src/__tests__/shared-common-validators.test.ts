import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";

/**
 * Tests for security-critical bash validation functions in shared/common.sh.
 *
 * These functions prevent injection attacks across ALL cloud provider scripts:
 * - validate_model_id: prevents command injection via model ID parameters
 * - validate_server_name: prevents injection via server/instance names
 * - validate_api_token: prevents injection via API tokens
 * - validate_region_name: prevents injection via region/zone parameters
 * - validate_resource_name: prevents injection via resource type/size params
 * - json_escape: safe JSON string encoding
 *
 * Each function is tested by sourcing shared/common.sh and calling it directly
 * in a bash subprocess. This catches real bash behavior (regex engine quirks,
 * quoting edge cases) that TypeScript replica tests would miss.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash validator function and return the exit code.
 * Sources shared/common.sh, then calls the named function with the given argument.
 */
function runValidator(funcName: string, arg: string): { exitCode: number; stderr: string } {
  // Use printf to safely pass the argument without shell interpretation
  // The argument is base64-encoded to avoid any shell quoting issues
  const b64 = Buffer.from(arg).toString("base64");
  const script = `
    source "${COMMON_SH}"
    ARG="$(echo "${b64}" | base64 -d)"
    ${funcName} "$ARG"
  `;
  try {
    execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stderr: "" };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, stderr: err.stderr || "" };
  }
}

/**
 * Run json_escape and return the output string.
 */
function runJsonEscape(input: string): string {
  const b64 = Buffer.from(input).toString("base64");
  const script = `
    source "${COMMON_SH}"
    INPUT="$(echo "${b64}" | base64 -d)"
    json_escape "$INPUT"
  `;
  try {
    const result = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (err: any) {
    return err.stdout?.trim() || "";
  }
}

// ── validate_model_id ───────────────────────────────────────────────────

describe("validate_model_id", () => {
  describe("accepts valid model IDs", () => {
    const validModels = [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "google/gemini-pro-1.5",
      "meta-llama/llama-3.1-70b-instruct",
      "mistralai/mixtral-8x7b:free",
      "deepseek/deepseek-coder-v2",
      "cohere/command-r-plus",
      "nousresearch/hermes-3-llama-3.1-405b",
      "openrouter/auto",
    ];

    for (const model of validModels) {
      it(`should accept "${model}"`, () => {
        const result = runValidator("validate_model_id", model);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  it("should accept empty string (optional parameter)", () => {
    const result = runValidator("validate_model_id", "");
    expect(result.exitCode).toBe(0);
  });

  describe("rejects injection attempts", () => {
    const malicious = [
      "model; rm -rf /",
      "model$(whoami)",
      "model`id`",
      'model"injection',
      "model'injection",
      "model|cat /etc/passwd",
      "model&background",
      "model<input",
      "model>output",
      "model\\escape",
      "model\nnewline",
      "model space",
      "model\ttab",
    ];

    for (const input of malicious) {
      it(`should reject "${input.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`, () => {
        const result = runValidator("validate_model_id", input);
        expect(result.exitCode).not.toBe(0);
      });
    }
  });
});

// ── validate_server_name ────────────────────────────────────────────────

describe("validate_server_name", () => {
  describe("accepts valid server names", () => {
    const valid = [
      "spawn-claude-abc",
      "my-server-123",
      "test",
      "a".repeat(63),       // max length
      "abc",                 // min length
      "ABC",                 // uppercase allowed
      "Server-Name-123",
      "123-numbers-first",
    ];

    for (const name of valid) {
      it(`should accept "${name.length > 30 ? name.substring(0, 27) + "..." : name}"`, () => {
        const result = runValidator("validate_server_name", name);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("rejects invalid server names", () => {
    it("should reject empty string", () => {
      const result = runValidator("validate_server_name", "");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name too short (2 chars)", () => {
      const result = runValidator("validate_server_name", "ab");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name too long (64 chars)", () => {
      const result = runValidator("validate_server_name", "a".repeat(64));
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with leading dash", () => {
      const result = runValidator("validate_server_name", "-server");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with trailing dash", () => {
      const result = runValidator("validate_server_name", "server-");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with spaces", () => {
      const result = runValidator("validate_server_name", "my server");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with special characters", () => {
      const result = runValidator("validate_server_name", "server;rm");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with dots", () => {
      const result = runValidator("validate_server_name", "server.name");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with underscores", () => {
      const result = runValidator("validate_server_name", "server_name");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with shell metacharacters", () => {
      const result = runValidator("validate_server_name", "server$(id)");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("boundary cases", () => {
    it("should accept exactly 3 characters", () => {
      const result = runValidator("validate_server_name", "abc");
      expect(result.exitCode).toBe(0);
    });

    it("should accept exactly 63 characters", () => {
      const result = runValidator("validate_server_name", "a".repeat(63));
      expect(result.exitCode).toBe(0);
    });

    it("should reject exactly 2 characters", () => {
      const result = runValidator("validate_server_name", "ab");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject exactly 64 characters", () => {
      const result = runValidator("validate_server_name", "a".repeat(64));
      expect(result.exitCode).not.toBe(0);
    });
  });
});

// ── validate_api_token ──────────────────────────────────────────────────

describe("validate_api_token", () => {
  describe("accepts valid tokens", () => {
    const valid = [
      "sk-or-v1-abc123def456",
      "hcloud_abcdef1234567890",
      "dop_v1_abcdef1234567890abcdef",
      "ABCDEFGHIJKLMNOP",
      "simple-token-123",
      "token_with_underscores",
      "a".repeat(200),   // long tokens OK
      "token.with.dots",
      "token=with=equals",
      "token+with+plus",
      "token/with/slashes",
      "token:with:colons",
      "token@with@at",
      "token~with~tilde",
    ];

    for (const token of valid) {
      it(`should accept "${token.length > 30 ? token.substring(0, 27) + "..." : token}"`, () => {
        const result = runValidator("validate_api_token", token);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("rejects empty and injection tokens", () => {
    it("should reject empty string", () => {
      const result = runValidator("validate_api_token", "");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("empty");
    });

    const injectionTokens = [
      { input: "token;rm -rf /", desc: "semicolon" },
      { input: "token'injection", desc: "single quote" },
      { input: 'token"injection', desc: "double quote" },
      { input: "token<input", desc: "angle bracket <" },
      { input: "token>output", desc: "angle bracket >" },
      { input: "token|pipe", desc: "pipe" },
      { input: "token&background", desc: "ampersand" },
      { input: "token$VAR", desc: "dollar sign" },
      { input: "token`id`", desc: "backtick" },
      { input: "token\\escape", desc: "backslash" },
      { input: "token(sub)", desc: "open paren" },
      { input: "token)sub", desc: "close paren" },
    ];

    for (const { input, desc } of injectionTokens) {
      it(`should reject token with ${desc}`, () => {
        const result = runValidator("validate_api_token", input);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("special characters");
      });
    }
  });
});

// ── validate_region_name ────────────────────────────────────────────────

describe("validate_region_name", () => {
  describe("accepts valid regions", () => {
    const valid = [
      "us-east-1",
      "eu-west-1",
      "ap-southeast-2",
      "fsn1",
      "nbg1-dc3",
      "nyc1",
      "sfo3",
      "lon1",
      "us_east_1",
      "EU-WEST",
    ];

    for (const region of valid) {
      it(`should accept "${region}"`, () => {
        const result = runValidator("validate_region_name", region);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("rejects invalid regions", () => {
    it("should reject empty string", () => {
      const result = runValidator("validate_region_name", "");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject region with spaces", () => {
      const result = runValidator("validate_region_name", "us east");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject region with semicolons", () => {
      const result = runValidator("validate_region_name", "us;rm");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject region exceeding 63 characters", () => {
      const result = runValidator("validate_region_name", "a".repeat(64));
      expect(result.exitCode).not.toBe(0);
    });

    it("should accept region at exactly 63 characters", () => {
      const result = runValidator("validate_region_name", "a".repeat(63));
      expect(result.exitCode).toBe(0);
    });

    it("should accept single character region", () => {
      const result = runValidator("validate_region_name", "a");
      expect(result.exitCode).toBe(0);
    });
  });
});

// ── validate_resource_name ──────────────────────────────────────────────

describe("validate_resource_name", () => {
  describe("accepts valid resource names", () => {
    const valid = [
      "cx21",
      "s-1vcpu-1gb",
      "vc2-1c-1gb",
      "g6-nanode-1",
      "e2-micro",
      "t3.micro",
      "Standard_B1s",
      "n1-standard-1",
    ];

    for (const name of valid) {
      it(`should accept "${name}"`, () => {
        const result = runValidator("validate_resource_name", name);
        expect(result.exitCode).toBe(0);
      });
    }
  });

  describe("rejects invalid resource names", () => {
    it("should reject empty string", () => {
      const result = runValidator("validate_resource_name", "");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with spaces", () => {
      const result = runValidator("validate_resource_name", "my resource");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name with shell metacharacters", () => {
      const result = runValidator("validate_resource_name", "cx21;rm");
      expect(result.exitCode).not.toBe(0);
    });

    it("should reject name exceeding 63 characters", () => {
      const result = runValidator("validate_resource_name", "a".repeat(64));
      expect(result.exitCode).not.toBe(0);
    });

    it("should accept name at exactly 63 characters", () => {
      const result = runValidator("validate_resource_name", "a".repeat(63));
      expect(result.exitCode).toBe(0);
    });

    it("should accept dots in name", () => {
      // validate_resource_name allows dots (unlike validate_server_name)
      const result = runValidator("validate_resource_name", "t3.micro");
      expect(result.exitCode).toBe(0);
    });
  });
});

// ── json_escape ─────────────────────────────────────────────────────────

describe("json_escape", () => {
  it("should escape a simple string", () => {
    const result = runJsonEscape("hello world");
    expect(result).toBe('"hello world"');
  });

  it("should escape double quotes", () => {
    const result = runJsonEscape('say "hello"');
    expect(result).toBe('"say \\"hello\\""');
  });

  it("should escape backslashes", () => {
    const result = runJsonEscape("path\\to\\file");
    expect(result).toBe('"path\\\\to\\\\file"');
  });

  it("should escape newlines", () => {
    const result = runJsonEscape("line1\nline2");
    expect(result).toBe('"line1\\nline2"');
  });

  it("should escape tabs", () => {
    const result = runJsonEscape("col1\tcol2");
    expect(result).toBe('"col1\\tcol2"');
  });

  it("should handle empty string", () => {
    const result = runJsonEscape("");
    expect(result).toBe('""');
  });

  it("should handle string with only special characters", () => {
    const result = runJsonEscape('"\\');
    const parsed = JSON.parse(result);
    expect(parsed).toBe('"\\');
  });

  it("should produce valid JSON for various inputs", () => {
    const inputs = [
      "simple text",
      "text with 'single quotes'",
      'text with "double quotes"',
      "text with\nnewlines\nand\ttabs",
      "path/to/file",
      "special: !@#%^*(){}[]",
      "unicode: cafe\u0301",
    ];

    for (const input of inputs) {
      const result = runJsonEscape(input);
      // Should be parseable as valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
      // Should round-trip back to the original string
      expect(JSON.parse(result)).toBe(input);
    }
  });

  it("should handle SSH key content safely", () => {
    // This was a security finding: triple-quote injection in SSH keys
    const sshKey = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ""" + __import__("os").system("id") + """';
    const result = runJsonEscape(sshKey);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toBe(sshKey);
  });

  it("should handle long strings", () => {
    const longStr = "a".repeat(10000);
    const result = runJsonEscape(longStr);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toBe(longStr);
  });
});

// ── Cross-function security: combined validation ────────────────────────

describe("combined security validation", () => {
  describe("common injection patterns blocked by all validators", () => {
    const injections = [
      "$(whoami)",
      "`id`",
      "; cat /etc/passwd",
    ];

    const validators = [
      "validate_server_name",
      "validate_api_token",
    ];

    for (const validator of validators) {
      for (const injection of injections) {
        it(`${validator} should block "${injection}"`, () => {
          const result = runValidator(validator, injection);
          expect(result.exitCode).not.toBe(0);
        });
      }
    }
  });

  describe("validate_model_id blocks non-alphanumeric patterns", () => {
    const injections = [
      "model; rm -rf /",
      "model$(whoami)",
      "model`id`",
      "model | cat /etc/passwd",
    ];

    for (const injection of injections) {
      it(`should block "${injection}"`, () => {
        const result = runValidator("validate_model_id", injection);
        expect(result.exitCode).not.toBe(0);
      });
    }
  });
});
