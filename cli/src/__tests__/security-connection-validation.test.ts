/**
 * Tests for connection parameter validation (security-critical)
 * These functions prevent command injection via corrupted history files
 */

import { describe, it, expect } from "bun:test";
import { validateConnectionIP, validateUsername, validateServerIdentifier } from "../security.js";

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
      expect(() => validateConnectionIP("fly-ssh")).not.toThrow();
      expect(() => validateConnectionIP("daytona-sandbox")).not.toThrow();
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
      expect(() => validateConnectionIP("localhost")).toThrow(/Invalid connection IP/);
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
