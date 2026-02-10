import { describe, it, expect } from "bun:test";
import { validateIdentifier, validateScriptContent, validatePrompt } from "../security";

/**
 * Tests for security validation with encoding edge cases and
 * tricky inputs that bypass simple pattern matching.
 *
 * These complement security.test.ts and security-edge-cases.test.ts
 * by testing:
 * - Unicode/encoding attacks on identifiers
 * - Script content with various line endings
 * - Prompt validation with embedded control characters
 * - Regex boundary conditions in dangerous pattern detection
 *
 * Agent: test-engineer
 */

describe("Security Encoding Edge Cases", () => {
  describe("validateIdentifier - encoding attacks", () => {
    it("should reject null byte in identifier", () => {
      expect(() => validateIdentifier("agent\x00name", "Test")).toThrow("invalid characters");
    });

    it("should reject unicode homoglyphs", () => {
      // Cyrillic 'a' looks like Latin 'a' but is different
      expect(() => validateIdentifier("cl\u0430ude", "Test")).toThrow("invalid characters");
    });

    it("should reject zero-width characters", () => {
      expect(() => validateIdentifier("agent\u200Bname", "Test")).toThrow("invalid characters");
    });

    it("should reject right-to-left override character", () => {
      expect(() => validateIdentifier("agent\u202Ename", "Test")).toThrow("invalid characters");
    });

    it("should accept identifier with only hyphens", () => {
      expect(() => validateIdentifier("---", "Test")).not.toThrow();
    });

    it("should accept identifier with only underscores", () => {
      expect(() => validateIdentifier("___", "Test")).not.toThrow();
    });

    it("should accept numeric-only identifiers", () => {
      expect(() => validateIdentifier("123", "Test")).not.toThrow();
    });

    it("should reject windows path separator", () => {
      expect(() => validateIdentifier("agent\\name", "Test")).toThrow("invalid characters");
    });

    it("should reject URL-encoded path traversal", () => {
      expect(() => validateIdentifier("%2e%2e", "Test")).toThrow("invalid characters");
    });
  });

  describe("validateScriptContent - line ending edge cases", () => {
    it("should handle scripts with Windows line endings (CRLF)", () => {
      const script = "#!/bin/bash\r\necho hello\r\n";
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should handle scripts with mixed line endings", () => {
      const script = "#!/bin/bash\r\necho line1\necho line2\r\n";
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should detect dangerous patterns across CRLF lines", () => {
      const script = "#!/bin/bash\r\nrm -rf /\r\n";
      expect(() => validateScriptContent(script)).toThrow("destructive filesystem operation");
    });

    it("should handle script with BOM marker", () => {
      const script = "\uFEFF#!/bin/bash\necho ok";
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should accept script with only shebang", () => {
      const script = "#!/bin/bash";
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should handle very long scripts", () => {
      let script = "#!/bin/bash\n";
      for (let i = 0; i < 1000; i++) {
        script += `echo "line ${i}"\n`;
      }
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should accept curl|bash with tabs (used by spawn scripts)", () => {
      const script = "#!/bin/bash\ncurl http://example.com/s.sh |\tbash";
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should detect rm -rf with tabs", () => {
      const script = "#!/bin/bash\nrm\t-rf\t/\n";
      expect(() => validateScriptContent(script)).toThrow("destructive filesystem operation");
    });

    it("should accept rm -rf with paths that start with word chars", () => {
      const script = "#!/bin/bash\nrm -rf /tmp\n";
      expect(() => validateScriptContent(script)).not.toThrow();
    });
  });

  describe("validatePrompt - control character edge cases", () => {
    it("should accept prompts with tab characters", () => {
      expect(() => validatePrompt("Step 1:\tDo this\nStep 2:\tDo that")).not.toThrow();
    });

    it("should accept prompts with carriage returns", () => {
      expect(() => validatePrompt("Fix this\r\nAnd that\r\n")).not.toThrow();
    });

    it("should detect command substitution with nested parens", () => {
      expect(() => validatePrompt("$(echo $(whoami))")).toThrow("command substitution");
    });

    it("should accept dollar sign followed by space", () => {
      expect(() => validatePrompt("The cost is $ 100")).not.toThrow();
    });

    it("should detect backticks even with whitespace inside", () => {
      expect(() => validatePrompt("Run ` whoami `")).toThrow("command substitution backticks");
    });

    it("should detect empty backticks", () => {
      expect(() => validatePrompt("Use `` for inline code")).toThrow("command substitution backticks");
    });

    it("should accept single backtick (not closed)", () => {
      expect(() => validatePrompt("Use the ` character for quoting")).not.toThrow();
    });

    it("should reject piping to bash in complex expressions", () => {
      expect(() => validatePrompt("echo 'data' | sort | bash")).toThrow("piping to bash");
    });

    it("should accept 'bash' as standalone word not after pipe", () => {
      expect(() => validatePrompt("Install bash on the system")).not.toThrow();
      expect(() => validatePrompt("Use bash to run scripts")).not.toThrow();
    });

    it("should accept 'sh' as standalone word not after pipe", () => {
      expect(() => validatePrompt("Use sh for POSIX compatibility")).not.toThrow();
    });

    it("should detect rm -rf with semicolons and spaces", () => {
      expect(() => validatePrompt("do something ;  rm  -rf /")).toThrow("command chaining with rm -rf");
    });

    it("should accept semicolons not followed by rm", () => {
      expect(() => validatePrompt("echo hello; echo world")).not.toThrow();
    });

    it("should handle prompt with only whitespace", () => {
      expect(() => validatePrompt("   \t\n  ")).toThrow("Prompt cannot be empty");
    });
  });
});
