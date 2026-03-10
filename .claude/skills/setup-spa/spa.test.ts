import type { ToolCall } from "./helpers";

import { afterEach, describe, expect, it, mock } from "bun:test";
import streamEvents from "../../../fixtures/claude-code/stream-events.json";
import { toRecord } from "@openrouter/spawn-shared";
import {
  downloadSlackFile,
  extractMarkdownTables,
  extractToolHint,
  findThread,
  formatToolHistory,
  formatToolStats,
  looksLikeHtml,
  MARKDOWN_TABLE_RE,
  markdownTableToSlackBlock,
  markdownToRichTextBlocks,
  markdownToSlack,
  openDb,
  parseInlineMarkdown,
  parseMarkdownBlock,
  parseStreamEvent,
  plainTextFallback,
  stripMention,
  upsertThread,
} from "./helpers";

// Helper: extract a fixture event by index and cast to Record<string, unknown>
function fixture(index: number): Record<string, unknown> {
  const event = toRecord(streamEvents[index]);
  if (!event) {
    throw new Error(`Fixture at index ${index} is not a record`);
  }
  return event;
}

describe("parseStreamEvent", () => {
  it("parses assistant text from fixture", () => {
    // fixture[0]: assistant with text "I'll look at the issue..."
    const result = parseStreamEvent(fixture(0));
    expect(result?.kind).toBe("text");
    expect(result?.text).toContain("I'll look at the issue and check the repository structure.");
  });

  it("parses assistant tool_use (Bash) from fixture with toolName and toolHint", () => {
    // fixture[1]: assistant with tool_use Bash
    const result = parseStreamEvent(fixture(1));
    expect(result?.kind).toBe("tool_use");
    expect(result?.toolName).toBe("Bash");
    expect(result?.toolHint).toContain("gh issue list");
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

  it("parses assistant tool_use (Glob) from fixture with toolName and toolHint", () => {
    // fixture[3]: assistant with tool_use Glob
    const result = parseStreamEvent(fixture(3));
    expect(result?.kind).toBe("tool_use");
    expect(result?.toolName).toBe("Glob");
    expect(result?.toolHint).toBe("**/*.ts");
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

  it("parses final assistant text from fixture", () => {
    // fixture[7]: assistant with summary text
    const result = parseStreamEvent(fixture(7));
    expect(result?.kind).toBe("text");
    expect(result?.text).toContain("#1234");
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
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: {
              command: longCmd,
            },
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("...");
    expect(result?.toolHint).toContain("...");
    expect(result?.kind).toBe("tool_use");
  });

  it("returns null for empty assistant content", () => {
    const event: Record<string, unknown> = {
      type: "assistant",
      message: {
        content: [],
      },
    };
    expect(parseStreamEvent(event)).toBeNull();
  });

  it("returns null for unknown event types", () => {
    expect(
      parseStreamEvent({
        type: "unknown",
      }),
    ).toBeNull();
  });

  it("returns null for assistant without message", () => {
    expect(
      parseStreamEvent({
        type: "assistant",
      }),
    ).toBeNull();
  });

  it("returns null for user without tool_result blocks", () => {
    const event: Record<string, unknown> = {
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: "not a tool result",
          },
        ],
      },
    };
    expect(parseStreamEvent(event)).toBeNull();
  });

  it("handles tool_use without input gracefully", () => {
    const event: Record<string, unknown> = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.kind).toBe("tool_use");
    expect(result?.toolName).toBe("Bash");
    expect(result?.toolHint).toBe("");
    expect(result?.text).toBe(":hammer_and_wrench: *Bash*");
  });

  it("prefers tool_use over text when both present", () => {
    const event: Record<string, unknown> = {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "some text",
          },
          {
            type: "tool_use",
            name: "Bash",
            input: {
              command: "echo hi",
            },
          },
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
        content: [
          {
            type: "tool_result",
            content: "",
          },
        ],
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
        content: [
          {
            type: "tool_result",
            content: longResult,
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.text).toContain("...");
  });

  it("handles web_search_tool_result blocks", () => {
    const event: Record<string, unknown> = {
      type: "user",
      message: {
        content: [
          {
            type: "web_search_tool_result",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com",
                title: "Example",
              },
            ],
          },
        ],
      },
    };
    const result = parseStreamEvent(event);
    expect(result?.kind).toBe("tool_result");
    expect(result?.text).toContain("https://example.com");
    expect(result?.text).toContain("Example");
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

  it("returns plain text unchanged", () => {
    expect(markdownToSlack("no markdown here")).toContain("no markdown here");
  });

  it("handles empty string", () => {
    expect(markdownToSlack("")).toBe("");
  });
});

describe("extractToolHint", () => {
  it("extracts command from input", () => {
    const block: Record<string, unknown> = {
      input: {
        command: "gh issue list --repo OpenRouterTeam/spawn",
      },
    };
    expect(extractToolHint(block)).toBe("gh issue list --repo OpenRouterTeam/spawn");
  });

  it("extracts pattern from input", () => {
    const block: Record<string, unknown> = {
      input: {
        pattern: "**/*.ts",
      },
    };
    expect(extractToolHint(block)).toBe("**/*.ts");
  });

  it("extracts file_path from input", () => {
    const block: Record<string, unknown> = {
      input: {
        file_path: "/home/user/spawn/index.ts",
      },
    };
    expect(extractToolHint(block)).toBe("/home/user/spawn/index.ts");
  });

  it("extracts query from input (WebSearch)", () => {
    const block: Record<string, unknown> = {
      input: {
        query: "spawn deploy fix",
      },
    };
    expect(extractToolHint(block)).toBe("spawn deploy fix");
  });

  it("extracts url from input (WebFetch)", () => {
    const block: Record<string, unknown> = {
      input: {
        url: "https://example.com/docs",
      },
    };
    expect(extractToolHint(block)).toBe("https://example.com/docs");
  });

  it("prefers command over pattern and file_path", () => {
    const block: Record<string, unknown> = {
      input: {
        command: "echo hi",
        pattern: "*.ts",
        file_path: "/foo",
      },
    };
    expect(extractToolHint(block)).toBe("echo hi");
  });

  it("truncates hints longer than 80 chars", () => {
    const longCmd = "x".repeat(100);
    const block: Record<string, unknown> = {
      input: {
        command: longCmd,
      },
    };
    const result = extractToolHint(block);
    expect(result).toHaveLength(83); // 80 + "..."
    expect(result).toEndWith("...");
  });

  it("returns empty string for missing input", () => {
    expect(extractToolHint({})).toBe("");
  });

  it("returns empty string for input without recognized keys", () => {
    const block: Record<string, unknown> = {
      input: {
        unknown_key: "value",
      },
    };
    expect(extractToolHint(block)).toBe("");
  });
});

describe("formatToolStats", () => {
  it("formats a single tool count", () => {
    const counts = new Map([
      [
        "Bash",
        3,
      ],
    ]);
    expect(formatToolStats(counts)).toBe("3× Bash");
  });

  it("formats multiple tool counts", () => {
    const counts = new Map<string, number>([
      [
        "Bash",
        1,
      ],
      [
        "Read",
        4,
      ],
      [
        "Grep",
        5,
      ],
      [
        "Glob",
        8,
      ],
    ]);
    expect(formatToolStats(counts)).toBe("1× Bash, 4× Read, 5× Grep, 8× Glob");
  });

  it("returns empty string for empty map", () => {
    expect(formatToolStats(new Map())).toBe("");
  });
});

describe("formatToolHistory", () => {
  it("formats a single tool call with Slack emoji icons", () => {
    const history: ToolCall[] = [
      {
        name: "Bash",
        hint: "echo hi",
      },
    ];
    expect(formatToolHistory(history)).toBe(":white_check_mark: *Bash* `echo hi`");
  });

  it("formats multiple tool calls", () => {
    const history: ToolCall[] = [
      {
        name: "Bash",
        hint: "gh issue list",
      },
      {
        name: "Glob",
        hint: "**/*.ts",
      },
    ];
    const result = formatToolHistory(history);
    expect(result).toContain(":white_check_mark: *Bash* `gh issue list`");
    expect(result).toContain(":white_check_mark: *Glob* `**/*.ts`");
  });

  it("marks errored tools with :x: emoji", () => {
    const history: ToolCall[] = [
      {
        name: "Bash",
        hint: "rm -rf /",
        errored: true,
      },
      {
        name: "Read",
        hint: "file.ts",
      },
    ];
    const result = formatToolHistory(history);
    expect(result).toContain(":x: *Bash*");
    expect(result).toContain(":white_check_mark: *Read*");
  });

  it("handles tools without hints", () => {
    const history: ToolCall[] = [
      {
        name: "Bash",
        hint: "",
      },
    ];
    expect(formatToolHistory(history)).toBe(":white_check_mark: *Bash*");
  });

  it("returns empty string for empty history", () => {
    expect(formatToolHistory([])).toBe("");
  });
});

describe("downloadSlackFile", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns Ok with local path on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("file-content", {
          status: 200,
        }),
      ),
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
      Promise.resolve(
        new Response("Not Found", {
          status: 404,
        }),
      ),
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

  it("returns Err when response Content-Type is text/html (auth redirect)", async () => {
    const originalFetch = globalThis.fetch;
    const htmlBody = "<!DOCTYPE html><html><head></head><body>Sign in</body></html>";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(htmlBody, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        }),
      ),
    );

    try {
      const result = await downloadSlackFile(
        "https://files.slack.com/image.png",
        "image.png",
        "thread-html-ct",
        "xoxb-fake-token",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("HTML instead of file data");
        expect(result.error.message).toContain("files:read");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns Err when response body is HTML despite non-html Content-Type", async () => {
    const originalFetch = globalThis.fetch;
    const htmlBody = "<!DOCTYPE html><html><head></head><body>Login page</body></html>";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(htmlBody, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
          },
        }),
      ),
    );

    try {
      const result = await downloadSlackFile(
        "https://files.slack.com/image.png",
        "image.png",
        "thread-html-body",
        "xoxb-fake-token",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("contains HTML");
        expect(result.error.message).toContain("auth redirect");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("looksLikeHtml", () => {
  it("detects <!DOCTYPE html> prefix", () => {
    const buf = Buffer.from("<!DOCTYPE html><html><body></body></html>");
    expect(looksLikeHtml(buf)).toBe(true);
  });

  it("detects <html> prefix", () => {
    const buf = Buffer.from("<html lang='en'><body></body></html>");
    expect(looksLikeHtml(buf)).toBe(true);
  });

  it("detects HTML with leading whitespace", () => {
    const buf = Buffer.from("  \n  <!doctype html><html></html>");
    expect(looksLikeHtml(buf)).toBe(true);
  });

  it("returns false for PNG magic bytes", () => {
    const buf = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);
    expect(looksLikeHtml(buf)).toBe(false);
  });

  it("returns false for JPEG magic bytes", () => {
    const buf = Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
    ]);
    expect(looksLikeHtml(buf)).toBe(false);
  });

  it("returns false for plain text", () => {
    const buf = Buffer.from("Just some plain text content");
    expect(looksLikeHtml(buf)).toBe(false);
  });

  it("returns false for empty buffer", () => {
    const buf = Buffer.from("");
    expect(looksLikeHtml(buf)).toBe(false);
  });
});

describe("SQLite state", () => {
  it("openDb returns a working database", () => {
    const db = openDb(":memory:");
    expect(db).toBeTruthy();
    db.close();
  });

  it("upsertThread and findThread round-trip", () => {
    const db = openDb(":memory:");
    upsertThread(db, {
      channel: "C123",
      threadTs: "1234.567",
      sessionId: "sess-abc",
      createdAt: new Date().toISOString(),
      userId: "U456",
    });
    const found = findThread(db, "C123", "1234.567");
    expect(found?.sessionId).toBe("sess-abc");
    expect(found?.userId).toBe("U456");
    db.close();
  });

  it("upsertThread is idempotent — updates session on conflict", () => {
    const db = openDb(":memory:");
    upsertThread(db, {
      channel: "C123",
      threadTs: "1234.567",
      sessionId: "sess-v1",
      createdAt: new Date().toISOString(),
    });
    upsertThread(db, {
      channel: "C123",
      threadTs: "1234.567",
      sessionId: "sess-v2",
      createdAt: new Date().toISOString(),
    });
    const found = findThread(db, "C123", "1234.567");
    expect(found?.sessionId).toBe("sess-v2");
    db.close();
  });

  it("findThread returns undefined for missing thread", () => {
    const db = openDb(":memory:");
    expect(findThread(db, "CNOPE", "0.0")).toBeUndefined();
    db.close();
  });
});

describe("parseInlineMarkdown", () => {
  it("returns plain text element for plain text", () => {
    const result = parseInlineMarkdown("hello world");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "text",
      text: "hello world",
    });
  });

  it("parses bold **text**", () => {
    const result = parseInlineMarkdown("**bold**");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "text",
      text: "bold",
      style: {
        bold: true,
      },
    });
  });

  it("parses inline code `code`", () => {
    const result = parseInlineMarkdown("`code`");
    expect(result[0]).toMatchObject({
      type: "text",
      text: "code",
      style: {
        code: true,
      },
    });
  });

  it("parses link [text](url)", () => {
    const result = parseInlineMarkdown("[click](https://example.com)");
    expect(result[0]).toMatchObject({
      type: "link",
      url: "https://example.com",
      text: "click",
    });
  });

  it("parses strikethrough ~~text~~", () => {
    const result = parseInlineMarkdown("~~gone~~");
    expect(result[0]).toMatchObject({
      type: "text",
      text: "gone",
      style: {
        strike: true,
      },
    });
  });

  it("parses italic *text*", () => {
    const result = parseInlineMarkdown("*italic*");
    expect(result[0]).toMatchObject({
      type: "text",
      text: "italic",
      style: {
        italic: true,
      },
    });
  });

  it("handles mixed inline elements", () => {
    const result = parseInlineMarkdown("Hello **bold** and `code` world");
    expect(result.length).toBeGreaterThan(2);
    const boldEl = result.find(
      (e) =>
        typeof e === "object" &&
        "style" in e &&
        (e as Record<string, unknown>).style !== null &&
        typeof (e as Record<string, unknown>).style === "object" &&
        "bold" in ((e as Record<string, unknown>).style as object),
    );
    expect(boldEl).toBeTruthy();
  });

  it("returns empty array for empty string", () => {
    expect(parseInlineMarkdown("")).toHaveLength(0);
  });
});

describe("parseMarkdownBlock", () => {
  it("produces rich_text_section for plain paragraph", () => {
    const result = parseMarkdownBlock("Hello world");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "rich_text_section",
    });
  });

  it("produces rich_text_list for bullet list", () => {
    const result = parseMarkdownBlock("- item one\n- item two");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "rich_text_list",
      style: "bullet",
    });
    const list = result[0] as {
      elements: unknown[];
    };
    expect(list.elements).toHaveLength(2);
  });

  it("produces rich_text_list for ordered list", () => {
    const result = parseMarkdownBlock("1. first\n2. second\n3. third");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "rich_text_list",
      style: "ordered",
    });
  });

  it("produces rich_text_quote for blockquote", () => {
    const result = parseMarkdownBlock("> quoted text");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "rich_text_quote",
    });
  });

  it("produces bold rich_text_section for ATX header", () => {
    const result = parseMarkdownBlock("## My Header");
    expect(result).toHaveLength(1);
    const section = result[0] as {
      type: string;
      elements: Array<{
        style?: {
          bold?: boolean;
        };
      }>;
    };
    expect(section.type).toBe("rich_text_section");
    expect(section.elements[0]?.style?.bold).toBe(true);
  });

  it("returns empty array for blank input", () => {
    expect(parseMarkdownBlock("")).toHaveLength(0);
    expect(parseMarkdownBlock("   ")).toHaveLength(0);
  });
});

describe("markdownToRichTextBlocks", () => {
  it("returns empty array for blank input", () => {
    expect(markdownToRichTextBlocks("")).toHaveLength(0);
    expect(markdownToRichTextBlocks("   ")).toHaveLength(0);
  });

  it("wraps plain text in a rich_text block", () => {
    const result = markdownToRichTextBlocks("Hello world");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "rich_text",
    });
  });

  it("splits fenced code blocks into separate rich_text blocks", () => {
    const input = "Before\n```\nconst x = 1;\n```\nAfter";
    const result = markdownToRichTextBlocks(input);
    // Before text + code block + after text = 3 blocks
    expect(result).toHaveLength(3);
    // Second block should contain preformatted element
    const codeBlock = result[1] as {
      elements: Array<{
        type: string;
      }>;
    };
    expect(codeBlock.elements[0]?.type).toBe("rich_text_preformatted");
  });

  it("handles unclosed fenced code block (mid-stream)", () => {
    const input = "Before\n```typescript\nconst x = 1;\n// more code";
    const result = markdownToRichTextBlocks(input);
    // Before text + unclosed code
    expect(result.length).toBeGreaterThanOrEqual(1);
    const hasPreformatted = result.some((b) => {
      const block = b as {
        elements?: Array<{
          type: string;
        }>;
      };
      return block.elements?.some((e) => e.type === "rich_text_preformatted");
    });
    expect(hasPreformatted).toBe(true);
  });

  it("handles multiple code blocks", () => {
    const input = "First\n```\ncode1\n```\nMiddle\n```\ncode2\n```\nLast";
    const result = markdownToRichTextBlocks(input);
    expect(result.length).toBeGreaterThanOrEqual(4);
  });
});

describe("plainTextFallback", () => {
  it("strips fenced code blocks to [code]", () => {
    const input = "Before\n```typescript\nconst x = 1;\n```\nAfter";
    const result = plainTextFallback(input);
    expect(result).toContain("[code]");
    expect(result).not.toContain("const x");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("strips bold **text** markers", () => {
    const result = plainTextFallback("**bold** text");
    expect(result).toContain("bold text");
    expect(result).not.toContain("**");
  });

  it("strips ATX headers", () => {
    const result = plainTextFallback("## My Header");
    expect(result).toContain("My Header");
    expect(result).not.toContain("##");
  });

  it("converts [text](url) links to plain text", () => {
    const result = plainTextFallback("[click here](https://example.com)");
    expect(result).toContain("click here");
    expect(result).not.toContain("https://example.com");
  });

  it("returns empty string for blank input", () => {
    expect(plainTextFallback("")).toBe("");
    expect(plainTextFallback("   ")).toBe("");
  });
});

describe("extractMarkdownTables", () => {
  it("extracts a simple markdown table", () => {
    const input = "Before\n| A | B |\n|---|---|\n| 1 | 2 |\nAfter";
    const { clean, tables } = extractMarkdownTables(input);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toContain("| A | B |");
    expect(clean).toContain("Before");
    expect(clean).toContain("After");
    expect(clean).not.toContain("| A |");
  });

  it("returns clean text unchanged when no table present", () => {
    const input = "Just some text\nno table here";
    const { clean, tables } = extractMarkdownTables(input);
    expect(tables).toHaveLength(0);
    expect(clean).toContain("Just some text");
  });

  it("MARKDOWN_TABLE_RE resets lastIndex between uses", () => {
    const input = "| X |\n|---|\n| Y |\n";
    MARKDOWN_TABLE_RE.lastIndex = 0;
    const m1 = input.match(MARKDOWN_TABLE_RE);
    MARKDOWN_TABLE_RE.lastIndex = 0;
    const m2 = input.match(MARKDOWN_TABLE_RE);
    expect(m1).toEqual(m2);
  });
});

describe("markdownTableToSlackBlock", () => {
  it("converts a simple table to Slack block format", () => {
    const table = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const block = markdownTableToSlackBlock(table) as {
      type: string;
      rows: Array<
        Array<{
          type: string;
          text: string;
        }>
      >;
    } | null;
    expect(block).not.toBeNull();
    expect(block?.type).toBe("table");
    expect(block?.rows).toHaveLength(3); // header + 2 data rows
    expect(block?.rows[0][0].text).toBe("Name");
    expect(block?.rows[0][1].text).toBe("Age");
    expect(block?.rows[1][0].text).toBe("Alice");
  });

  it("returns null for empty input", () => {
    expect(markdownTableToSlackBlock("")).toBeNull();
    expect(markdownTableToSlackBlock("  ")).toBeNull();
  });

  it("returns null for separator-only row", () => {
    expect(markdownTableToSlackBlock("|---|---|")).toBeNull();
  });

  it("pads short rows to consistent column count", () => {
    const table = "| A | B | C |\n|---|---|---|\n| x |";
    const block = markdownTableToSlackBlock(table) as {
      rows: Array<
        Array<{
          text: string;
        }>
      >;
    } | null;
    // Data row should be padded to 3 columns
    expect(block?.rows[1]).toHaveLength(3);
    expect(block?.rows[1][1].text).toBe("");
    expect(block?.rows[1][2].text).toBe("");
  });
});
