import { describe, it, expect } from "bun:test";
import { getScriptFailureGuidance, getStatusDescription } from "../commands";

/**
 * Tests for getScriptFailureGuidance() in commands.ts.
 *
 * This function maps exit codes from failed spawn scripts to user-facing
 * guidance strings. It was recently modified (PRs #450, #449) but has
 * zero direct test coverage.
 *
 * Agent: test-engineer
 */

describe("getScriptFailureGuidance", () => {
  // ── Exit code 127: command not found ──────────────────────────────────────

  describe("exit code 127 (command not found)", () => {
    it("should return guidance about missing commands", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      expect(lines[0]).toContain("command was not found");
    });

    it("should list required tools: bash, curl, ssh, jq", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("bash");
      expect(joined).toContain("curl");
      expect(joined).toContain("ssh");
      expect(joined).toContain("jq");
    });

    it("should reference the cloud name for CLI tools", () => {
      const lines = getScriptFailureGuidance(127, "hetzner");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn hetzner");
    });

    it("should embed a different cloud name when provided", () => {
      const lines = getScriptFailureGuidance(127, "vultr");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn vultr");
      expect(joined).not.toContain("spawn hetzner");
    });

    it("should return exactly 3 guidance lines", () => {
      const lines = getScriptFailureGuidance(127, "sprite");
      expect(lines).toHaveLength(3);
    });
  });

  // ── Exit code 126: permission denied ──────────────────────────────────────

  describe("exit code 126 (permission denied)", () => {
    it("should mention permission denied", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("permission denied");
    });

    it("should mention command could not be executed", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("could not be executed");
    });

    it("should return exactly 1 guidance line", () => {
      const lines = getScriptFailureGuidance(126, "sprite");
      expect(lines).toHaveLength(1);
    });
  });

  // ── Exit code 1: generic failure ──────────────────────────────────────────

  describe("exit code 1 (generic failure)", () => {
    it("should start with Common causes", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should mention credentials", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      const joined = lines.join("\n");
      expect(joined).toContain("credentials");
    });

    it("should reference the cloud name for setup", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn digital-ocean");
    });

    it("should mention API error causes", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("API error");
      expect(joined).toContain("quota");
    });

    it("should mention server provisioning failure", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("provisioning failed");
    });

    it("should return exactly 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(1, "sprite");
      expect(lines).toHaveLength(4);
    });
  });

  // ── Default case: unknown/other exit codes ────────────────────────────────

  describe("default case (unknown exit codes)", () => {
    it("should start with Common causes for unknown exit code", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should mention credentials for unknown exit code", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("credentials");
    });

    it("should mention rate limit or quota", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("rate limit");
      expect(joined).toContain("quota");
    });

    it("should mention missing local dependencies", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("SSH");
      expect(joined).toContain("curl");
      expect(joined).toContain("jq");
    });

    it("should reference the cloud name for setup instructions", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn linode");
    });

    it("should return exactly 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(42, "linode");
      expect(lines).toHaveLength(4);
    });
  });

  // ── null exit code (no exit code extracted) ───────────────────────────────

  describe("null exit code", () => {
    it("should fall through to default case", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should mention credentials", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("credentials");
    });

    it("should reference the cloud name", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn sprite");
    });

    it("should return exactly 4 guidance lines", () => {
      const lines = getScriptFailureGuidance(null, "sprite");
      expect(lines).toHaveLength(4);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle exit code 0 as default case", () => {
      const lines = getScriptFailureGuidance(0, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle very large exit code", () => {
      const lines = getScriptFailureGuidance(255, "hetzner");
      expect(lines[0]).toBe("Common causes:");
      expect(lines.length).toBeGreaterThan(0);
    });

    it("should handle negative exit code", () => {
      const lines = getScriptFailureGuidance(-1, "hetzner");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle exit code 130 (SIGINT) as default case", () => {
      const lines = getScriptFailureGuidance(130, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle exit code 137 (SIGKILL/OOM) as default case", () => {
      const lines = getScriptFailureGuidance(137, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle exit code 2 as default case", () => {
      const lines = getScriptFailureGuidance(2, "sprite");
      expect(lines[0]).toBe("Common causes:");
    });

    it("should handle empty cloud name", () => {
      const lines = getScriptFailureGuidance(127, "");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn ");
    });

    it("should handle cloud name with special characters", () => {
      const lines = getScriptFailureGuidance(1, "digital-ocean");
      const joined = lines.join("\n");
      expect(joined).toContain("spawn digital-ocean");
    });
  });

  // ── Return type and structure ─────────────────────────────────────────────

  describe("return type and structure", () => {
    it("should always return an array of strings", () => {
      const codes: (number | null)[] = [0, 1, 2, 126, 127, 130, 137, 255, null];
      for (const code of codes) {
        const lines = getScriptFailureGuidance(code, "sprite");
        expect(Array.isArray(lines)).toBe(true);
        for (const line of lines) {
          expect(typeof line).toBe("string");
        }
      }
    });

    it("should never return an empty array", () => {
      const codes: (number | null)[] = [0, 1, 2, 126, 127, 130, 255, null, -1];
      for (const code of codes) {
        const lines = getScriptFailureGuidance(code, "sprite");
        expect(lines.length).toBeGreaterThan(0);
      }
    });

    it("should produce different output for each handled exit code", () => {
      const result127 = getScriptFailureGuidance(127, "sprite");
      const result126 = getScriptFailureGuidance(126, "sprite");
      const result1 = getScriptFailureGuidance(1, "sprite");
      const resultDefault = getScriptFailureGuidance(42, "sprite");

      // 127 and 126 should be distinct from each other
      expect(result127.join("\n")).not.toBe(result126.join("\n"));
      // 127 and 1 should be distinct
      expect(result127.join("\n")).not.toBe(result1.join("\n"));
      // 126 and 1 should be distinct
      expect(result126.join("\n")).not.toBe(result1.join("\n"));
      // 1 and default should be distinct (different wording)
      expect(result1.join("\n")).not.toBe(resultDefault.join("\n"));
    });
  });
});
