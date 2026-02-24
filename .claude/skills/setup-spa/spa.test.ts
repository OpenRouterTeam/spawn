import { describe, it, expect } from "bun:test";
import { parseStreamEvent, stripMention } from "./helpers";

describe("parseStreamEvent", () => {
  it("parses assistant text message", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "text", text: "Hello world" });
  });

  it("parses assistant tool_use message", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "tool_use", text: ":hammer_and_wrench: *Bash* `ls -la`" });
  });

  it("truncates long tool hints to 80 chars", () => {
    const longCmd = "a".repeat(100);
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: longCmd } }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("...");
    expect(result?.kind).toBe("tool_use");
  });

  it("parses tool_use with pattern hint", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "tool_use", text: ":hammer_and_wrench: *Glob* `**/*.ts`" });
  });

  it("parses tool_use with file_path hint", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/foo/bar.ts" } }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "tool_use", text: ":hammer_and_wrench: *Read* `/foo/bar.ts`" });
  });

  it("parses user tool_result message", () => {
    const event = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "output text", is_error: false }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.kind).toBe("tool_result");
    expect(result?.text).toContain(":white_check_mark: Result");
    expect(result?.text).toContain("output text");
  });

  it("parses user tool_result error", () => {
    const event = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "error message", is_error: true }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.kind).toBe("tool_result");
    expect(result?.text).toContain(":x: Error");
  });

  it("truncates long tool results to 500 chars", () => {
    const longResult = "x".repeat(600);
    const event = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: longResult }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("...");
  });

  it("returns null for empty assistant content", () => {
    const event = {
      type: "assistant",
      message: { content: [] },
    };
    expect(parseStreamEvent(event)).toBeNull();
  });

  it("returns null for unknown event types", () => {
    expect(parseStreamEvent({ type: "unknown" })).toBeNull();
  });

  it("returns null for assistant without message", () => {
    expect(parseStreamEvent({ type: "assistant" })).toBeNull();
  });

  it("returns null for user without tool_result blocks", () => {
    const event = {
      type: "user",
      message: {
        content: [{ type: "text", text: "not a tool result" }],
      },
    };
    expect(parseStreamEvent(event)).toBeNull();
  });

  it("handles tool_use without input gracefully", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash" }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "tool_use", text: ":hammer_and_wrench: *Bash*" });
  });

  it("prefers tool_use over text when both present", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "some text" },
          { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.kind).toBe("tool_use");
  });

  it("handles empty tool_result content", () => {
    const event = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "" }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("(empty)");
  });
});

describe("stripMention", () => {
  it("strips a single mention", () => {
    expect(stripMention("<@U12345> hello")).toBe("hello");
  });

  it("strips multiple mentions", () => {
    expect(stripMention("<@U12345> <@U67890> hello")).toBe("hello");
  });

  it("returns text without mentions unchanged", () => {
    expect(stripMention("hello world")).toBe("hello world");
  });

  it("trims whitespace", () => {
    expect(stripMention("  <@U12345>  ")).toBe("");
  });
});
