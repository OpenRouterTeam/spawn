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
      expect(result.stdout).toBe("true");
    });

    it("should extract a null field and return default", () => {
      const result = runBash(`
        _extract_json_field '{"value": null}' "d['value']" "fallback"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fallback");
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

  describe("complex JS expressions", () => {
    it("should support bracket access for existing key", () => {
      const result = runBash(`
        _extract_json_field '{"status": "active"}' "d['status']"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("active");
    });

    it("should return default when key missing", () => {
      const result = runBash(`
        _extract_json_field '{"other": 1}' "d['status']" "unknown"
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
        _extract_json_field '{}' "d['key']" "empty"
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

// extract_api_error_message tests are in shared-common-error-polling.test.ts
