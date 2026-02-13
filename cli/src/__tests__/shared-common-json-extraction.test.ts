import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";

/**
 * Tests for JSON extraction helpers in shared/common.sh:
 * - _extract_json_field: generic JSON field extraction using Python expressions
 * - extract_api_error_message: API error message extraction from cloud provider responses
 *
 * These functions were recently extracted (PRs #673, #767) and are critical
 * infrastructure used by cloud providers for JSON parsing and error reporting.
 * _extract_json_field is used by generic_wait_for_instance for status polling,
 * and extract_api_error_message is used by Hetzner, DigitalOcean, Vultr, and
 * Contabo for surfacing actionable error messages.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ── _extract_json_field ─────────────────────────────────────────────────

describe("_extract_json_field", () => {
  describe("basic field extraction", () => {
    it("should extract a top-level string field", () => {
      const result = runBash(`
        _extract_json_field '{"name": "test"}' "d['name']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("test");
    });

    it("should extract a top-level integer field", () => {
      const result = runBash(`
        _extract_json_field '{"count": 42}' "d['count']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("42");
    });

    it("should extract a nested field", () => {
      const result = runBash(`
        _extract_json_field '{"server": {"status": "running"}}' "d['server']['status']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("running");
    });

    it("should extract a deeply nested field", () => {
      const result = runBash(`
        _extract_json_field '{"a": {"b": {"c": {"d": "deep"}}}}' "d['a']['b']['c']['d']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("deep");
    });

    it("should extract a boolean field", () => {
      const result = runBash(`
        _extract_json_field '{"ready": true}' "d['ready']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("True");
    });

    it("should extract a null field", () => {
      const result = runBash(`
        _extract_json_field '{"value": null}' "d['value']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("None");
    });
  });

  describe("default value handling", () => {
    it("should return default when JSON is invalid", () => {
      const result = runBash(`
        _extract_json_field 'not-json' "d['key']" "fallback"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fallback");
    });

    it("should return default when key is missing", () => {
      const result = runBash(`
        _extract_json_field '{"other": "value"}' "d['missing']" "default-val"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("default-val");
    });

    it("should return empty string when no default specified and key is missing", () => {
      const result = runBash(`
        _extract_json_field '{"other": "value"}' "d['missing']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("should return default when JSON is empty string", () => {
      const result = runBash(`
        _extract_json_field '' "d['key']" "empty-fallback"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("empty-fallback");
    });

    it("should return default when nested key path fails", () => {
      const result = runBash(`
        _extract_json_field '{"a": {"b": 1}}' "d['a']['c']['d']" "nested-default"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("nested-default");
    });
  });

  describe("complex Python expressions", () => {
    it("should support .get() with default", () => {
      const result = runBash(`
        _extract_json_field '{"status": "active"}' "d.get('status', 'unknown')"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("active");
    });

    it("should support .get() default when key missing", () => {
      const result = runBash(`
        _extract_json_field '{"other": 1}' "d.get('status', 'unknown')"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unknown");
    });

    it("should support array indexing", () => {
      const result = runBash(`
        _extract_json_field '{"ips": ["1.2.3.4", "5.6.7.8"]}' "d['ips'][0]"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1.2.3.4");
    });

    it("should support conditional expressions", () => {
      const result = runBash(`
        _extract_json_field '{"networks": {"v4": [{"ip_address": "10.0.0.1"}]}}' \
          "d['networks']['v4'][0]['ip_address']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("10.0.0.1");
    });
  });

  describe("real-world cloud provider patterns", () => {
    it("should extract Vultr instance status", () => {
      const json = '{"instance": {"status": "active", "main_ip": "203.0.113.1"}}';
      const result = runBash(`
        _extract_json_field '${json}' "d['instance']['status']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("active");
    });

    it("should extract Vultr instance IP", () => {
      const json = '{"instance": {"status": "active", "main_ip": "203.0.113.1"}}';
      const result = runBash(`
        _extract_json_field '${json}' "d['instance']['main_ip']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("203.0.113.1");
    });

    it("should extract DigitalOcean droplet status", () => {
      const json = '{"droplet": {"status": "active", "networks": {"v4": [{"ip_address": "10.0.0.5", "type": "public"}]}}}';
      const result = runBash(`
        _extract_json_field '${json}' "d['droplet']['status']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("active");
    });

    it("should handle unknown status gracefully", () => {
      const result = runBash(`
        _extract_json_field '{}' "d['instance']['status']" "unknown"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unknown");
    });
  });

  describe("edge cases", () => {
    it("should handle JSON with special characters in values", () => {
      const result = runBash(`
        _extract_json_field '{"msg": "hello world & more"}' "d['msg']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world & more");
    });

    it("should handle JSON with unicode characters", () => {
      const result = runBash(`
        _extract_json_field '{"msg": "\\u00e9"}' "d['msg']"
      `);
      expect(result.exitCode).toBe(0);
      // Python should decode the unicode escape
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("should handle large JSON responses", () => {
      // Build a JSON with many keys
      const pairs = Array.from({ length: 50 }, (_, i) => `"key${i}": "val${i}"`).join(", ");
      const json = `{${pairs}, "target": "found"}`;
      const result = runBash(`
        _extract_json_field '${json}' "d['target']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("found");
    });

    it("should handle JSON with numeric string keys", () => {
      const result = runBash(`
        _extract_json_field '{"123": "numeric-key"}' "d['123']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("numeric-key");
    });

    it("should handle empty JSON object", () => {
      const result = runBash(`
        _extract_json_field '{}' "d.get('key', 'empty')"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("empty");
    });

    it("should handle JSON array as root", () => {
      const result = runBash(`
        _extract_json_field '[1, 2, 3]' "d[0]"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1");
    });
  });
});

// ── extract_api_error_message ─────────────────────────────────────────────

describe("extract_api_error_message", () => {
  describe("standard error field: message", () => {
    it("should extract top-level 'message' field", () => {
      const result = runBash(`
        extract_api_error_message '{"message": "Rate limit exceeded"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Rate limit exceeded");
    });

    it("should prefer error.message over top-level message", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {"message": "inner error"}, "message": "outer error"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("inner error");
    });
  });

  describe("standard error field: error (string)", () => {
    it("should extract 'error' when it is a string", () => {
      const result = runBash(`
        extract_api_error_message '{"error": "unauthorized"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unauthorized");
    });
  });

  describe("standard error field: error.message", () => {
    it("should extract error.message from nested error object", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {"message": "Invalid API key"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API key");
    });
  });

  describe("standard error field: error.error_message", () => {
    it("should extract error.error_message", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {"error_message": "Quota exceeded"}}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Quota exceeded");
    });
  });

  describe("standard error field: reason", () => {
    it("should extract 'reason' field", () => {
      const result = runBash(`
        extract_api_error_message '{"reason": "Server capacity full"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Server capacity full");
    });
  });

  describe("fallback behavior", () => {
    it("should return default fallback for invalid JSON", () => {
      const result = runBash(`
        extract_api_error_message 'not valid json'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should return custom fallback for invalid JSON", () => {
      const result = runBash(`
        extract_api_error_message 'not valid json' 'Custom fallback'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Custom fallback");
    });

    it("should return fallback when JSON has no recognized error fields", () => {
      const result = runBash(`
        extract_api_error_message '{"status": 500, "data": null}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should return custom fallback when no recognized fields", () => {
      const result = runBash(`
        extract_api_error_message '{"status": 500}' 'API returned 500'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("API returned 500");
    });

    it("should return fallback for empty JSON object", () => {
      const result = runBash(`
        extract_api_error_message '{}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should return fallback for empty string input", () => {
      const result = runBash(`
        extract_api_error_message ''
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });
  });

  describe("field priority order", () => {
    it("should prefer error.message over error string", () => {
      // When error is a dict with message, that takes priority
      const result = runBash(`
        extract_api_error_message '{"error": {"message": "detailed"}, "reason": "generic"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("detailed");
    });

    it("should prefer error.error_message when error.message is absent", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {"error_message": "specific"}, "message": "generic"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("specific");
    });

    it("should fall back to message when error is not a dict", () => {
      const result = runBash(`
        extract_api_error_message '{"error": 42, "message": "top-level message"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("top-level message");
    });

    it("should fall back to reason when message is absent", () => {
      const result = runBash(`
        extract_api_error_message '{"error": 42, "reason": "the reason"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("the reason");
    });

    it("should use error string when no dict or other fields", () => {
      const result = runBash(`
        extract_api_error_message '{"error": "simple string error"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("simple string error");
    });
  });

  describe("real-world cloud provider error responses", () => {
    it("should parse Hetzner error format", () => {
      const json = '{"error": {"message": "server limit exceeded", "code": "limit_exceeded"}}';
      const result = runBash(`
        extract_api_error_message '${json}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("server limit exceeded");
    });

    it("should parse DigitalOcean error format", () => {
      const json = '{"id": "unauthorized", "message": "Unable to authenticate you"}';
      const result = runBash(`
        extract_api_error_message '${json}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unable to authenticate you");
    });

    it("should parse Vultr error format", () => {
      const json = '{"error": "Invalid API token", "status": 401}';
      const result = runBash(`
        extract_api_error_message '${json}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Invalid API token");
    });

    it("should parse Contabo error format", () => {
      const json = '{"error": {"message": "Insufficient credits"}, "statusCode": 402}';
      const result = runBash(`
        extract_api_error_message '${json}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Insufficient credits");
    });

    it("should parse Linode error format", () => {
      const json = '{"errors": [{"reason": "Not found"}]}';
      const result = runBash(`
        extract_api_error_message '${json}' 'Linode API error'
      `);
      // Linode uses errors[] array, not a field extract_api_error_message checks.
      // Should fall back to custom fallback.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Linode API error");
    });

    it("should handle HTML error page gracefully", () => {
      const result = runBash(`
        extract_api_error_message '<html><body>502 Bad Gateway</body></html>' 'Server error'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Server error");
    });

    it("should handle rate limit response", () => {
      const json = '{"message": "API rate limit exceeded. Try again in 30 seconds."}';
      const result = runBash(`
        extract_api_error_message '${json}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("API rate limit exceeded. Try again in 30 seconds.");
    });
  });

  describe("edge cases", () => {
    it("should handle error field set to null", () => {
      const result = runBash(`
        extract_api_error_message '{"error": null, "message": "null error"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("null error");
    });

    it("should handle error field set to empty string", () => {
      const result = runBash(`
        extract_api_error_message '{"error": "", "message": "empty error field"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("empty error field");
    });

    it("should handle error field set to empty dict", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {}, "message": "dict but empty"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("dict but empty");
    });

    it("should handle error dict with message set to empty string", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {"message": ""}, "reason": "fallback reason"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fallback reason");
    });

    it("should handle message field with special characters", () => {
      const result = runBash(`
        extract_api_error_message '{"message": "Error: can'\\''t connect to host (port 443)"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("connect to host");
    });

    it("should handle very long error messages", () => {
      const longMsg = "x".repeat(500);
      const result = runBash(`
        extract_api_error_message '{"message": "${longMsg}"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(500);
    });

    it("should handle JSON with only numeric fields", () => {
      const result = runBash(`
        extract_api_error_message '{"code": 403, "status": 403}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Unknown error");
    });

    it("should handle JSON array input", () => {
      const result = runBash(`
        extract_api_error_message '[{"error": "bad"}]' 'array input'
      `);
      expect(result.exitCode).toBe(0);
      // JSON array root doesn't have .get(), should fall back
      expect(result.stdout).toBe("array input");
    });

    it("should handle error with both message and error_message", () => {
      const result = runBash(`
        extract_api_error_message '{"error": {"message": "primary", "error_message": "secondary"}}'
      `);
      expect(result.exitCode).toBe(0);
      // message should take priority over error_message
      expect(result.stdout).toBe("primary");
    });

    it("should handle boolean error field", () => {
      const result = runBash(`
        extract_api_error_message '{"error": true, "message": "bool error"}'
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("bool error");
    });
  });
});
