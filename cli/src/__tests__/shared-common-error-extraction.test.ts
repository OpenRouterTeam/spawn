import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

/**
 * Tests for extract_api_error_message in shared/common.sh.
 *
 * This function parses JSON error responses from cloud provider APIs and
 * extracts human-readable error messages. It is used by Hetzner, DigitalOcean,
 * Vultr, and Contabo cloud providers. It tries these fields in priority order:
 *   1. error.message (when error is a dict)
 *   2. error.error_message (when error is a dict)
 *   3. message (top-level)
 *   4. reason (top-level)
 *   5. error (when error is a string)
 *   6. fallback argument (default: "Unknown error")
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-err-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Run a bash snippet that sources shared/common.sh first.
 */
function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
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

// ── extract_api_error_message ───────────────────────────────────────────────

describe("extract_api_error_message", () => {
  // ── Priority 1: error.message (error is a dict) ───────────────────

  describe("error.message field (nested dict)", () => {
    it("should extract error.message from Hetzner-style response", () => {
      const result = runBash(`
        extract_api_error_message '{"error":{"message":"server limit exceeded","code":"limit_exceeded"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("server limit exceeded");
    });

    it("should extract error.message from DigitalOcean-style response", () => {
      const result = runBash(`
        extract_api_error_message '{"id":"service_unavailable","error":{"message":"Server is temporarily unavailable"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Server is temporarily unavailable");
    });
  });

  // ── Priority 2: error.error_message (error is a dict) ─────────────

  describe("error.error_message field (nested dict)", () => {
    it("should extract error.error_message when error.message is absent", () => {
      const result = runBash(`
        extract_api_error_message '{"error":{"error_message":"Rate limit exceeded","code":429}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Rate limit exceeded");
    });

    it("should prefer error.message over error.error_message", () => {
      const result = runBash(`
        extract_api_error_message '{"error":{"message":"primary msg","error_message":"secondary msg"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("primary msg");
    });
  });

  // ── Priority 3: top-level message ─────────────────────────────────

  describe("top-level message field", () => {
    it("should extract top-level message when no error dict", () => {
      const result = runBash(`
        extract_api_error_message '{"message":"Unauthorized","status":401}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unauthorized");
    });

    it("should extract top-level message when error is empty string", () => {
      const result = runBash(`
        extract_api_error_message '{"error":"","message":"Invalid API key"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API key");
    });
  });

  // ── Priority 4: top-level reason ──────────────────────────────────

  describe("top-level reason field", () => {
    it("should extract reason when no message or error fields", () => {
      const result = runBash(`
        extract_api_error_message '{"reason":"Quota exceeded","code":403}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Quota exceeded");
    });
  });

  // ── Priority 5: error as string ───────────────────────────────────

  describe("error as string", () => {
    it("should extract error string from Vultr-style response", () => {
      const result = runBash(`
        extract_api_error_message '{"error":"Invalid API token","status":401}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API token");
    });

    it("should prefer top-level message over error string", () => {
      const result = runBash(`
        extract_api_error_message '{"error":"short error","message":"Detailed error message"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Detailed error message");
    });
  });

  // ── Fallback behavior ─────────────────────────────────────────────

  describe("fallback behavior", () => {
    it("should use default fallback for empty JSON object", () => {
      const result = runBash(`
        extract_api_error_message '{}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should use custom fallback when provided", () => {
      const result = runBash(`
        extract_api_error_message '{}' 'Custom fallback message'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Custom fallback message");
    });

    it("should use fallback for invalid JSON", () => {
      const result = runBash(`
        extract_api_error_message 'not valid json'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should use custom fallback for invalid JSON", () => {
      const result = runBash(`
        extract_api_error_message 'not valid json' 'Parse failed'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Parse failed");
    });

    it("should use fallback for empty string input", () => {
      const result = runBash(`
        extract_api_error_message ''
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should use fallback when error dict has no message fields", () => {
      const result = runBash(`
        extract_api_error_message '{"error":{"code":"LIMIT_EXCEEDED"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });
  });

  // ── Realistic cloud provider responses ────────────────────────────

  describe("realistic cloud provider API responses", () => {
    it("should handle Hetzner uniqueness error", () => {
      const result = runBash(`
        extract_api_error_message '{"error":{"message":"SSH key with the same fingerprint already exists","code":"uniqueness_error"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("SSH key with the same fingerprint already exists");
    });

    it("should handle Vultr authentication error", () => {
      const result = runBash(`
        extract_api_error_message '{"error":"Invalid API key. Check the key and try again.","status":401}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API key. Check the key and try again.");
    });

    it("should handle DigitalOcean rate limit", () => {
      const result = runBash(`
        extract_api_error_message '{"id":"too_many_requests","message":"API rate limit exceeded"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("API rate limit exceeded");
    });

    it("should handle Contabo insufficient balance", () => {
      const result = runBash(`
        extract_api_error_message '{"error":{"message":"Insufficient balance to create instance","code":"insufficient_balance"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Insufficient balance to create instance");
    });

    it("should handle raw HTML error page as fallback", () => {
      const result = runBash(`
        extract_api_error_message '<html><body>502 Bad Gateway</body></html>' 'Unable to parse error'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unable to parse error");
    });

    it("should handle response passed as its own fallback", () => {
      // Cloud providers sometimes pass $response as fallback
      const rawResponse = '{"some_unknown_field":"value"}';
      const result = runBash(`
        extract_api_error_message '${rawResponse}' '${rawResponse}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(rawResponse);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle JSON array (not object)", () => {
      const result = runBash(`
        extract_api_error_message '[1,2,3]'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle JSON number", () => {
      const result = runBash(`
        extract_api_error_message '42'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle JSON null", () => {
      const result = runBash(`
        extract_api_error_message 'null'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle JSON boolean", () => {
      const result = runBash(`
        extract_api_error_message 'false'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle error message with special characters", () => {
      const result = runBash(`
        extract_api_error_message '{"message":"Error: Can'\\''t connect to server (port 443)"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Error:");
      expect(result.stdout).toContain("connect to server");
    });

    it("should handle deeply nested but irrelevant structure", () => {
      const result = runBash(`
        extract_api_error_message '{"data":{"nested":{"deep":"value"}}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle error field set to null", () => {
      const result = runBash(`
        extract_api_error_message '{"error":null}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle error field set to numeric value", () => {
      const result = runBash(`
        extract_api_error_message '{"error":500}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle message field with empty string", () => {
      const result = runBash(`
        extract_api_error_message '{"message":""}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle multiple valid fields - priority order", () => {
      // When both error.message and top-level message exist, error.message wins
      const result = runBash(`
        extract_api_error_message '{"error":{"message":"nested error"},"message":"top level","reason":"a reason"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("nested error");
    });

    it("should handle error dict with empty message falling to top-level", () => {
      // error.message is empty string, so it's falsy -> falls to top-level message
      const result = runBash(`
        extract_api_error_message '{"error":{"message":""},"message":"top level msg"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("top level msg");
    });
  });
});
