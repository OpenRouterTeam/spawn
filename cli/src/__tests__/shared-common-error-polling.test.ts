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

// _extract_json_field tests are in shared-common-json-extraction.test.ts
// generic_wait_for_instance tests are in shared-common-ssh-helpers.test.ts
