import { describe, it, expect, mock, afterEach } from "bun:test";
import { parseStreamEvent, stripMention, markdownToSlack, loadState, saveState, downloadSlackFile } from "./helpers";
import { toRecord } from "@openrouter/spawn-shared";
import streamEvents from "../../../fixtures/claude-code/stream-events.json";

// Helper: extract a fixture event by index and cast to Record<string, unknown>
function fixture(index: number): Record<string, unknown> {
  const event = toRecord(streamEvents[index]);
  if (!event) throw new Error(`Fixture at index ${index} is not a record`);
  return event;
}

describe("parseStreamEvent", () => {
  it("parses assistant text from fixture", () => {
    // fixture[0]: assistant with text "I'll look at the issue..."
    const result = parseStreamEvent(fixture(0));
    expect(result?.kind).toBe("text");
    expect(result?.text).toContain("I'll look at the issue and check the repository structure.");
  });

  it("parses assistant tool_use (Bash) from fixture with toolName", () => {
    // fixture[1]: assistant with tool_use Bash
    const result = parseStreamEvent(fixture(1));
    expect(result?.kind).toBe("tool_use");
    expect(result?.toolName).toBe("Bash");
    expect(result?.text).toContain(":hammer_and_wrench: *Bash*");
    expect(result?.text).toContain("gh issue list");
  });

  it("parses user tool_result (success) from fixture without isError", () => {
    // fixture[2]: user with successful tool_result
    const result = parseStreamEvent(fixture(2));
    expect(result?.kind).toBe("tool_result");
    expect(result?.isError).toBeUndefined();
    expect(result?.text).toContain(":white_check_mark: Result");
    expect(result?.text).toContain("Fly.io deploy fails on arm64");
  });

  it("parses assistant tool_use (Glob) from fixture with toolName", () => {
    // fixture[3]: assistant with tool_use Glob
    const result = parseStreamEvent(fixture(3));
    expect(result?.kind).toBe("tool_use");
    expect(result?.toolName).toBe("Glob");
    expect(result?.text).toBe(":hammer_and_wrench: *Glob* `**/*.ts`");
  });

  it("parses assistant tool_use (Read) from fixture", () => {
    // fixture[5]: assistant with tool_use Read
    const result = parseStreamEvent(fixture(5));
    expect(result?.kind).toBe("tool_use");
    expect(result?.text).toContain(":hammer_and_wrench: *Read*");
    expect(result?.text).toContain("index.ts");
  });

  it("parses user tool_result (error) from fixture with isError", () => {
    // fixture[6]: user with is_error: true
    const result = parseStreamEvent(fixture(6));
    expect(result?.kind).toBe("tool_result");
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain(":x: Error");
    expect(result?.text).toContain("Permission denied");
  });

  it("parses final assistant text from fixture with markdown→slack conversion", () => {
    // fixture[7]: assistant with summary text containing **bold**
    const result = parseStreamEvent(fixture(7));
    expect(result?.kind).toBe("text");
    // **#1234** → *#1234* (Slack bold)
    expect(result?.text).toContain("*#1234*");
    expect(result?.text).not.toContain("**#1234**");
    // inline code preserved
    expect(result?.text).toContain("`--json`");
    expect(result?.text).toContain("Would you like me to create a new issue");
  });

  it("returns null for result event (not assistant/user)", () => {
    // fixture[8]: result event with session_id
    const result = parseStreamEvent(fixture(8));
    expect(result).toBeNull();
  });

  it("truncates long tool hints to 80 chars", () => {
    const longCmd = "a".repeat(100);
    const event: Record<string, unknown> = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: longCmd } }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("...");
    expect(result?.kind).toBe("tool_use");
  });

  it("returns null for empty assistant content", () => {
    const event: Record<string, unknown> = {
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
    const event: Record<string, unknown> = {
      type: "user",
      message: {
        content: [{ type: "text", text: "not a tool result" }],
      },
    };
    expect(parseStreamEvent(event)).toBeNull();
  });

  it("handles tool_use without input gracefully", () => {
    const event: Record<string, unknown> = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash" }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.kind).toBe("tool_use");
    expect(result?.toolName).toBe("Bash");
    expect(result?.text).toBe(":hammer_and_wrench: *Bash*");
  });

  it("prefers tool_use over text when both present", () => {
    const event: Record<string, unknown> = {
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
    const event: Record<string, unknown> = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "" }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("(empty)");
  });

  it("truncates long tool results to 500 chars", () => {
    const longResult = "x".repeat(600);
    const event: Record<string, unknown> = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: longResult }],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("...");
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

describe("markdownToSlack", () => {
  it("converts bold to Slack format", () => {
    const result = markdownToSlack("This is **bold** text");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("**bold**");
  });

  it("converts markdown links to Slack format", () => {
    const result = markdownToSlack("[click here](https://example.com)");
    expect(result).toContain("<https://example.com|click here>");
    expect(result).not.toContain("](");
  });

  it("converts headers to bold", () => {
    expect(markdownToSlack("## Summary")).toContain("*Summary*");
  });

  it("converts strikethrough", () => {
    const result = markdownToSlack("~~removed~~");
    expect(result).toContain("~removed~");
    expect(result).not.toContain("~~");
  });

  it("preserves inline code", () => {
    const result = markdownToSlack("Use `**not bold**` here");
    expect(result).toContain("`**not bold**`");
  });

  it("preserves fenced code blocks", () => {
    const input = "Before\n```\n**not bold**\n```\nAfter **bold**";
    const result = markdownToSlack(input);
    expect(result).toContain("**not bold**");
    expect(result).toContain("*bold*");
  });

  it("handles the real SPA output pattern", () => {
    const input =
      "1. **[#1859 — Agent processes die](https://github.com/OpenRouterTeam/spawn/issues/1859)** — covers the root cause\n\n" +
      "The SIGTERM is the **smoking gun**.";
    const result = markdownToSlack(input);
    expect(result).toContain("<https://github.com/OpenRouterTeam/spawn/issues/1859|#1859");
    expect(result).toContain("*smoking gun*");
    expect(result).not.toContain("](");
  });

  it("returns plain text unchanged", () => {
    expect(markdownToSlack("no markdown here")).toContain("no markdown here");
  });

  it("handles empty string", () => {
    expect(markdownToSlack("")).toBe("");
  });
});

describe("loadState", () => {
  it("returns a Result object", () => {
    // STATE_PATH is captured at module load time; the default path likely
    // doesn't exist in CI, so loadState returns Ok({ mappings: [] })
    const result = loadState();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.mappings).toBeInstanceOf(Array);
    }
  });
});

describe("saveState", () => {
  it("returns a Result object", () => {
    // Write to a temp file by using the module's STATE_PATH (default).
    // If the default dir is writable, we get Ok; if not, Err. Either way it's a Result.
    const result = saveState({ mappings: [] });
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("downloadSlackFile", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns Ok with local path on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("file-content", { status: 200 })),
    );

    try {
      const threadTs = `test-${Date.now()}`;
      const result = await downloadSlackFile(
        "https://files.slack.com/test.txt",
        "test.txt",
        threadTs,
        "xoxb-fake-token",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toContain("test.txt");
        expect(result.data).toContain(threadTs);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns Err on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    );

    try {
      const result = await downloadSlackFile(
        "https://files.slack.com/missing.txt",
        "missing.txt",
        "thread-123",
        "xoxb-fake-token",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("404");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns Err on network failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new Error("Network failure")));

    try {
      const result = await downloadSlackFile(
        "https://files.slack.com/fail.txt",
        "fail.txt",
        "thread-456",
        "xoxb-fake-token",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Network failure");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
