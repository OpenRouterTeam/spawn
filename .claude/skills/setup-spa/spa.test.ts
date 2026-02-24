import { describe, it, expect } from "bun:test";

import { parseStreamEvent, stripMention } from "./helpers";

describe("parseStreamEvent", () => {
  it("parses assistant text messages", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "text", text: "Hello world" });
  });

  it("joins multiple text blocks", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).toEqual({ kind: "text", text: "Part 1Part 2" });
  });

  it("parses tool_use events", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "echo hello" },
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tool_use");
    expect(result!.text).toContain("*Bash*");
    expect(result!.text).toContain("`echo hello`");
  });

  it("prioritizes tool_use over text when both present", () => {
    const event = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me run this" },
          { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.ts" } },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tool_use");
  });

  it("parses tool_result (user) events", () => {
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tool_result");
    expect(result!.text).toContain("Result");
    expect(result!.text).toContain("file contents here");
  });

  it("marks error tool results", () => {
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: "command not found",
            is_error: true,
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).not.toBeNull();
    expect(result!.text).toContain(":x: Error");
  });

  it("truncates long tool results", () => {
    const longContent = "x".repeat(600);
    const event = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: longContent,
            is_error: false,
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("...");
    // Original is 600 chars, truncated to 500 + "..."
    expect(result!.text.length).toBeLessThan(longContent.length);
  });

  it("returns null for unknown event types", () => {
    expect(parseStreamEvent({ type: "system" })).toBeNull();
    expect(parseStreamEvent({ type: "result" })).toBeNull();
  });

  it("returns null for assistant with empty content", () => {
    const event = {
      type: "assistant",
      message: { content: [] },
    };
    expect(parseStreamEvent(event)).toBeNull();
  });

  it("returns null when message is not an object", () => {
    expect(parseStreamEvent({ type: "assistant", message: "not an object" })).toBeNull();
    expect(parseStreamEvent({ type: "user", message: null })).toBeNull();
  });

  it("truncates long tool hints to 80 chars", () => {
    const longCmd = "a".repeat(100);
    const event = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: longCmd },
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("...");
  });
});

describe("stripMention", () => {
  it("removes @mentions", () => {
    expect(stripMention("<@U12345> hello")).toBe("hello");
  });

  it("removes multiple @mentions", () => {
    expect(stripMention("<@U12345> <@U67890> hi")).toBe("hi");
  });

  it("preserves text without mentions", () => {
    expect(stripMention("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripMention("")).toBe("");
  });

  it("trims whitespace after removing mention", () => {
    expect(stripMention("<@UABC123>   hello  ")).toBe("hello");
  });
});
