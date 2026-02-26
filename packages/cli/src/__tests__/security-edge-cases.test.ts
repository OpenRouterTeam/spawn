import { describe, it, expect } from "bun:test";
import { validateIdentifier, validateScriptContent, validatePrompt } from "../security";

/**
 * Edge case tests for security validation functions.
 * Supplements the main security.test.ts with boundary conditions
 * and combinations that aren't covered there.
 */

describe("Security Edge Cases", () => {
  describe("validateIdentifier boundary conditions", () => {
    it("should accept identifier at exactly 64 characters", () => {
      const id = "a".repeat(64);
      expect(() => validateIdentifier(id, "Test")).not.toThrow();
    });

    it("should reject identifier at 65 characters", () => {
      const id = "a".repeat(65);
      expect(() => validateIdentifier(id, "Test")).toThrow("too long");
    });

    it("should accept single character identifiers", () => {
      expect(() => validateIdentifier("a", "Test")).not.toThrow();
      expect(() => validateIdentifier("1", "Test")).not.toThrow();
      expect(() => validateIdentifier("-", "Test")).not.toThrow();
      expect(() => validateIdentifier("_", "Test")).not.toThrow();
    });

    it("should accept identifiers with all valid character types", () => {
      expect(() => validateIdentifier("a1-_", "Test")).not.toThrow();
      expect(() => validateIdentifier("my-agent-v2", "Test")).not.toThrow();
      expect(() => validateIdentifier("cloud_provider_1", "Test")).not.toThrow();
      expect(() => validateIdentifier("0-start-with-number", "Test")).not.toThrow();
    });

    it("should reject identifiers with dots", () => {
      expect(() => validateIdentifier("my.agent", "Test")).toThrow("can only contain");
    });

    it("should reject identifiers with spaces", () => {
      expect(() => validateIdentifier("my agent", "Test")).toThrow("can only contain");
    });

    it("should reject tab characters", () => {
      expect(() => validateIdentifier("my\tagent", "Test")).toThrow("can only contain");
    });

    it("should reject newlines", () => {
      expect(() => validateIdentifier("my\nagent", "Test")).toThrow("can only contain");
    });

    it("should use custom field name in error messages", () => {
      expect(() => validateIdentifier("", "Cloud provider")).toThrow("Cloud provider");
      expect(() => validateIdentifier("UPPER", "Agent name")).toThrow("Agent name");
    });

    it("should reject URL-like identifiers", () => {
      expect(() => validateIdentifier("http://evil.com", "Test")).toThrow("can only contain");
      expect(() => validateIdentifier("https://evil.com", "Test")).toThrow("can only contain");
    });

    it("should reject shell metacharacters individually", () => {
      const shellChars = [
        "!",
        "@",
        "#",
        "$",
        "%",
        "^",
        "&",
        "*",
        "(",
        ")",
        "=",
        "+",
        "{",
        "}",
        "[",
        "]",
        "<",
        ">",
        "?",
        "~",
        "`",
        "'",
        '"',
        ";",
        ",",
        ".",
      ];
      for (const char of shellChars) {
        expect(() => validateIdentifier(`test${char}name`, "Test")).toThrow("can only contain");
      }
    });
  });

  describe("validateScriptContent edge cases", () => {
    it("should accept scripts with various shebangs", () => {
      expect(() => validateScriptContent("#!/bin/bash\necho ok")).not.toThrow();
      expect(() => validateScriptContent("#!/usr/bin/env bash\necho ok")).not.toThrow();
      expect(() => validateScriptContent("#!/bin/sh\necho ok")).not.toThrow();
    });

    it("should accept scripts with shebang after leading whitespace", () => {
      // The code trims before checking, so leading whitespace should be handled
      expect(() => validateScriptContent("  #!/bin/bash\necho ok")).not.toThrow();
    });

    it("should reject scripts with only whitespace", () => {
      expect(() => validateScriptContent("   \n\t\n  ")).toThrow("is empty");
    });

    it("should accept rm -rf with specific directories (not root)", () => {
      const safe = `#!/bin/bash
rm -rf /tmp/test-dir
rm -rf /var/cache/myapp
rm -rf /home/user/.cache/app
`;
      expect(() => validateScriptContent(safe)).not.toThrow();
    });

    it("should detect rm -rf / even with extra spaces", () => {
      const script = `#!/bin/bash
rm  -rf  /
`;
      // The regex is rm\s+-rf\s+\/(?!\w) so extra spaces should be matched
      expect(() => validateScriptContent(script)).toThrow("destructive filesystem operation");
    });

    it("should accept scripts with comments containing dangerous patterns", () => {
      // Note: the current implementation checks the whole script text,
      // so commented-out dangerous patterns will still be caught.
      // This documents the current behavior.
      const script = `#!/bin/bash
# Don't do this: rm -rf /
echo "safe"
`;
      // The regex matches inside comments too - this is a known trade-off
      expect(() => validateScriptContent(script)).toThrow("destructive filesystem operation");
    });

    it("should accept wget|sh (used by spawn scripts)", () => {
      const script = `#!/bin/bash
wget -q https://example.com/install.sh | sh
`;
      expect(() => validateScriptContent(script)).not.toThrow();
    });

    it("should accept scripts with curl used safely", () => {
      const safe = `#!/bin/bash
curl -fsSL https://example.com/file.tar.gz -o /tmp/file.tar.gz
curl -s https://api.example.com/data > output.json
`;
      expect(() => validateScriptContent(safe)).not.toThrow();
    });

    it("should detect dd operations", () => {
      const script = `#!/bin/bash
dd if=/dev/urandom of=/tmp/random.bin bs=1M count=1
`;
      expect(() => validateScriptContent(script)).toThrow("raw disk operation");
    });

    it("should detect mkfs commands with various filesystems", () => {
      for (const fs of [
        "ext4",
        "xfs",
        "btrfs",
        "vfat",
      ]) {
        const script = `#!/bin/bash\nmkfs.${fs} /dev/sda1\n`;
        expect(() => validateScriptContent(script)).toThrow("filesystem formatting");
      }
    });
  });

  describe("validatePrompt edge cases", () => {
    it("should accept prompts with dollar signs in safe contexts", () => {
      expect(() => validatePrompt("The cost is $100")).not.toThrow();
      expect(() => validatePrompt("Variable $HOME is common")).not.toThrow();
      expect(() => validatePrompt("Price: $5.99")).not.toThrow();
    });

    it("should reject nested command substitution", () => {
      expect(() => validatePrompt("$($(whoami))")).toThrow("command substitution");
    });

    it("should reject backtick with complex commands", () => {
      expect(() => validatePrompt("Run `cat /etc/shadow`")).toThrow("backtick");
    });

    it("should accept prompts with pipe to non-shell commands", () => {
      expect(() => validatePrompt("List files | grep test")).not.toThrow();
      expect(() => validatePrompt("Show data | less")).not.toThrow();
      expect(() => validatePrompt("Count lines | wc -l")).not.toThrow();
    });

    it("should accept prompts at exactly the max length", () => {
      const maxPrompt = "x".repeat(10 * 1024);
      expect(() => validatePrompt(maxPrompt)).not.toThrow();
    });

    it("should reject prompts one byte over the max length", () => {
      const overPrompt = "x".repeat(10 * 1024 + 1);
      expect(() => validatePrompt(overPrompt)).toThrow("too long");
    });

    it("should accept prompts with semicolons not followed by rm", () => {
      expect(() => validatePrompt("Write code; test it; deploy it")).not.toThrow();
      expect(() => validatePrompt("Step 1; step 2; step 3")).not.toThrow();
    });

    it("should accept multi-line prompts", () => {
      const multiLine = "Line 1\nLine 2\nLine 3";
      expect(() => validatePrompt(multiLine)).not.toThrow();
    });

    it("should accept prompts with common programming symbols", () => {
      expect(() => validatePrompt("Implement func(x, y) -> z")).not.toThrow();
      expect(() => validatePrompt("Add a Map<string, number>")).not.toThrow();
      expect(() => validatePrompt("Use {destructuring} in JS")).not.toThrow();
      expect(() => validatePrompt("Check if a > b && c < d")).not.toThrow();
    });

    it("should detect piping to bash with extra whitespace", () => {
      expect(() => validatePrompt("Output |  bash")).toThrow("piping to bash");
      expect(() => validatePrompt("Execute |\tbash")).toThrow("piping to bash");
    });

    it("should detect piping to sh with extra whitespace", () => {
      expect(() => validatePrompt("Output |  sh")).toThrow("piping to sh");
    });
  });
});
