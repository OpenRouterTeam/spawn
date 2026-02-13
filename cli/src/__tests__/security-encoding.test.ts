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

// ── stripDangerousKeys (prototype pollution defense) ─────────────────────────

import { stripDangerousKeys } from "../manifest";

describe("stripDangerousKeys", () => {
  it("strips __proto__ from parsed JSON", () => {
    // JSON.parse produces an own-property __proto__ key (not inherited)
    const input = JSON.parse('{"agents":{},"clouds":{},"matrix":{},"__proto__":{"polluted":true}}');
    expect(Object.prototype.hasOwnProperty.call(input, "__proto__")).toBe(true);
    const result = stripDangerousKeys(input);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(result.agents).toEqual({});
  });

  it("strips constructor key", () => {
    const input = Object.assign(Object.create(null), { name: "test", constructor: { evil: true } });
    const result = stripDangerousKeys(input);
    expect(Object.keys(result)).toEqual(["name"]);
    expect(result.name).toBe("test");
  });

  it("strips prototype key", () => {
    const input = Object.assign(Object.create(null), { data: 1, prototype: { inject: true } });
    const result = stripDangerousKeys(input);
    expect(Object.keys(result)).toEqual(["data"]);
    expect(result.data).toBe(1);
  });

  it("strips dangerous keys from nested objects", () => {
    const input = { agents: { claude: { __proto__: { evil: true }, name: "Claude" } } };
    const result = stripDangerousKeys(input);
    expect(result.agents.claude.name).toBe("Claude");
    expect(Object.keys(result.agents.claude)).toEqual(["name"]);
  });

  it("handles arrays correctly", () => {
    const input = { items: [{ name: "a" }, { name: "b", __proto__: {} }] };
    const result = stripDangerousKeys(input);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe("a");
    expect(result.items[1].name).toBe("b");
  });

  it("passes through primitives unchanged", () => {
    expect(stripDangerousKeys("hello")).toBe("hello");
    expect(stripDangerousKeys(42)).toBe(42);
    expect(stripDangerousKeys(true)).toBe(true);
    expect(stripDangerousKeys(null)).toBe(null);
  });

  it("preserves normal keys", () => {
    const input = { agents: { a: 1 }, clouds: { b: 2 }, matrix: { c: 3 } };
    const result = stripDangerousKeys(input);
    expect(result).toEqual(input);
  });

  it("handles deeply nested dangerous keys", () => {
    const input = { a: { b: { c: { constructor: "bad", value: "good" } } } };
    const result = stripDangerousKeys(input);
    expect(result.a.b.c.value).toBe("good");
    expect(Object.keys(result.a.b.c)).toEqual(["value"]);
  });
});
