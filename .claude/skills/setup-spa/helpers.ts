// SPA helpers — pure functions for parsing Claude Code stream events,
// Slack formatting, state management (SQLite), and file download/cleanup.

import type { Block } from "@slack/bolt";
import type { Result } from "@openrouter/spawn-shared";

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { slackifyMarkdown } from "slackify-markdown";
import * as v from "valibot";
import { Err, Ok } from "@openrouter/spawn-shared";
import { isString, toRecord } from "@openrouter/spawn-shared";

// #region State — SQLite

/** Path to the SQLite DB. Derived from DB_PATH env, or alongside a STATE_PATH json, or default. */
const DB_PATH =
  process.env.DB_PATH ??
  (process.env.STATE_PATH ? process.env.STATE_PATH.replace(/\.json$/, ".db") : undefined) ??
  `${process.env.HOME ?? "/root"}/.config/spawn/state.db`;

/** Legacy JSON path — used only for one-time migration. */
const LEGACY_JSON_PATH = process.env.STATE_PATH ?? `${process.env.HOME ?? "/root"}/.config/spawn/slack-issues.json`;

/** A thread SPA has been involved in. Rows are deleted (not flagged) when concluded. */
export interface ThreadRow {
  channel: string;
  threadTs: string;
  sessionId: string;
  createdAt: string;
  userId?: string;
  lastActivityAt?: string;
  /** GitHub PR URLs SPA posted in this thread. */
  prUrls?: string[];
}

/** Raw SQLite row shape (snake_case, JSON-encoded arrays). */
interface RawThread {
  channel: string;
  thread_ts: string;
  session_id: string;
  created_at: string;
  user_id: string | null;
  last_activity_at: string | null;
  pr_urls: string | null;
}

function rowToThread(r: RawThread): ThreadRow {
  return {
    channel: r.channel,
    threadTs: r.thread_ts,
    sessionId: r.session_id,
    createdAt: r.created_at,
    userId: r.user_id ?? undefined,
    lastActivityAt: r.last_activity_at ?? undefined,
    prUrls: r.pr_urls
      ? Array.isArray(JSON.parse(r.pr_urls))
        ? JSON.parse(r.pr_urls).filter(isString)
        : undefined
      : undefined,
  };
}

/** Migrate legacy slack-issues.json → SQLite on first open. */
function migrateFromJson(db: Database): void {
  if (!existsSync(LEGACY_JSON_PATH)) {
    return;
  }
  const count = db
    .query<
      {
        n: number;
      },
      []
    >("SELECT COUNT(*) AS n FROM threads")
    .get();
  if (count && count.n > 0) {
    return;
  }
  try {
    const raw = readFileSync(LEGACY_JSON_PATH, "utf-8");
    const json = toRecord(JSON.parse(raw)) ?? {};
    const mappings = Array.isArray(json.mappings) ? json.mappings : [];

    const insertThread = db.prepare<
      void,
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT OR IGNORE INTO threads
         (channel, thread_ts, session_id, created_at, user_id, last_activity_at, pr_urls)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    let migrated = 0;
    for (const m of mappings) {
      const rec = toRecord(m);
      if (!rec) {
        continue;
      }
      insertThread.run(
        isString(rec.channel) ? rec.channel : "",
        isString(rec.threadTs) ? rec.threadTs : "",
        isString(rec.sessionId) ? rec.sessionId : "",
        isString(rec.createdAt) ? rec.createdAt : new Date().toISOString(),
        null,
        null,
        null,
      );
      migrated++;
    }

    console.log(`[spa] Migrated slack-issues.json → state.db (${migrated} threads)`);
  } catch (err) {
    console.error(`[spa] slack-issues.json migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Open (or create) the SQLite database, run schema migrations, and return the handle.
 * Pass `:memory:` as `path` in tests to get a fresh in-memory DB with no migration.
 */
export function openDb(path?: string): Database {
  const dbPath = path ?? DB_PATH;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), {
      recursive: true,
    });
  }
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS threads (
      channel           TEXT NOT NULL,
      thread_ts         TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      user_id           TEXT,
      last_activity_at  TEXT,
      pr_urls           TEXT,
      PRIMARY KEY (channel, thread_ts)
    )
  `);
  if (!path) {
    migrateFromJson(db);
  }
  return db;
}

/** Look up a thread by its Slack coordinates. Returns undefined if not found. */
export function findThread(db: Database, channel: string, threadTs: string): ThreadRow | undefined {
  const row = db
    .query<
      RawThread,
      [
        string,
        string,
      ]
    >("SELECT * FROM threads WHERE channel = ? AND thread_ts = ?")
    .get(channel, threadTs);
  return row ? rowToThread(row) : undefined;
}

/** Insert or update a thread record. On conflict, updates session/activity fields. */
export function upsertThread(db: Database, thread: ThreadRow): void {
  db.run(
    `INSERT INTO threads (channel, thread_ts, session_id, created_at, user_id, last_activity_at, pr_urls)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel, thread_ts) DO UPDATE SET
       session_id        = excluded.session_id,
       user_id           = COALESCE(excluded.user_id, user_id),
       last_activity_at  = excluded.last_activity_at,
       pr_urls           = CASE WHEN excluded.pr_urls IS NOT NULL THEN excluded.pr_urls ELSE pr_urls END`,
    [
      thread.channel,
      thread.threadTs,
      thread.sessionId,
      thread.createdAt,
      thread.userId ?? null,
      thread.lastActivityAt ?? null,
      thread.prUrls ? JSON.stringify(thread.prUrls) : null,
    ],
  );
}

/**
 * Update activity fields on an existing thread.
 * Merges prUrls with the existing set (deduped). No-ops if the row doesn't exist.
 */
export function updateThread(
  db: Database,
  channel: string,
  threadTs: string,
  opts: {
    sessionId?: string;
    userId?: string;
    lastActivityAt?: string;
    prUrls?: string[];
  },
): void {
  const current = findThread(db, channel, threadTs);
  if (!current) {
    return;
  }
  const mergedPrUrls =
    opts.prUrls && opts.prUrls.length > 0
      ? [
          ...new Set([
            ...(current.prUrls ?? []),
            ...opts.prUrls,
          ]),
        ]
      : current.prUrls;
  db.run(
    `UPDATE threads SET
       session_id        = ?,
       user_id           = ?,
       last_activity_at  = ?,
       pr_urls           = ?
     WHERE channel = ? AND thread_ts = ?`,
    [
      opts.sessionId ?? current.sessionId,
      current.userId ?? opts.userId ?? null,
      opts.lastActivityAt ?? current.lastActivityAt ?? null,
      mergedPrUrls ? JSON.stringify(mergedPrUrls) : null,
      channel,
      threadTs,
    ],
  );
}

// #endregion

// #region Claude Code stream parsing

export const ResultSchema = v.object({
  type: v.literal("result"),
  session_id: v.string(),
});

export interface SlackSegment {
  kind: "text" | "tool_use" | "tool_result";
  text: string;
  toolName?: string; // set for tool_use
  toolHint?: string; // set for tool_use — truncated command/pattern/path
  isError?: boolean; // set for tool_result
  tableBlocks?: object[]; // set for text — Slack table block objects extracted from markdown tables
}

/** Tracked tool call for history and stats. */
export interface ToolCall {
  name: string;
  hint: string;
  errored?: boolean;
}

/** Extract a truncated hint from a tool_use input block. */
export function extractToolHint(block: Record<string, unknown>): string {
  const input = toRecord(block.input);
  if (!input) {
    return "";
  }
  const hint =
    (isString(input.command) ? input.command : null) ??
    (isString(input.pattern) ? input.pattern : null) ??
    (isString(input.file_path) ? input.file_path : null) ??
    (isString(input.query) ? input.query : null) ??
    (isString(input.url) ? input.url : null);
  if (!hint) {
    return "";
  }
  return hint.length > 80 ? `${hint.slice(0, 80)}...` : hint;
}

/** Format a tool_use input block into a truncated backtick hint string. */
function formatToolHint(block: Record<string, unknown>): string {
  const hint = extractToolHint(block);
  if (!hint) {
    return "";
  }
  return ` \`${hint}\``;
}

/** Format tool counts into a compact stats string: "1× Bash, 4× Read, 5× Grep". */
export function formatToolStats(counts: ReadonlyMap<string, number>): string {
  return Array.from(counts.entries())
    .map(([name, count]) => `${count}\u00d7 ${name}`)
    .join(", ");
}

/** Format the full ordered tool history into a Slack-formatted list for the expandable attachment. */
export function formatToolHistory(history: readonly ToolCall[]): string {
  return history
    .map((t) => {
      const icon = t.errored ? ":x:" : ":white_check_mark:";
      const hint = t.hint ? ` \`${t.hint}\`` : "";
      return `${icon} *${t.name}*${hint}`;
    })
    .join("\n");
}

/** Parse an assistant-type event into a SlackSegment. */
function parseAssistantEvent(event: Record<string, unknown>): SlackSegment | null {
  const msg = toRecord(event.message);
  if (!msg) {
    return null;
  }
  const content = Array.isArray(msg.content) ? msg.content : [];

  const textParts: string[] = [];
  const tableBlocksList: object[] = [];
  const toolParts: string[] = [];
  let firstToolName: string | undefined;
  let firstToolHint: string | undefined;

  for (const rawBlock of content) {
    const block = toRecord(rawBlock);
    if (!block) {
      continue;
    }

    if (block.type === "text" && isString(block.text)) {
      // Extract markdown tables before conversion so they render as native Slack table blocks.
      const { clean, tables } = extractMarkdownTables(block.text);
      if (clean.trim()) {
        textParts.push(clean);
      }
      for (const table of tables) {
        const tb = markdownTableToSlackBlock(table);
        if (tb) {
          tableBlocksList.push(tb);
        }
      }
    }

    if (block.type === "tool_use" && isString(block.name)) {
      if (!firstToolName) {
        firstToolName = block.name;
        firstToolHint = extractToolHint(block);
      }
      toolParts.push(`:hammer_and_wrench: *${block.name}*${formatToolHint(block)}`);
    }
  }

  // Tool use takes priority — it's a distinct event kind
  if (toolParts.length > 0) {
    return {
      kind: "tool_use",
      text: toolParts.join("\n"),
      toolName: firstToolName,
      toolHint: firstToolHint,
    };
  }
  if (textParts.length > 0 || tableBlocksList.length > 0) {
    return {
      kind: "text",
      text: textParts.join(""),
      tableBlocks: tableBlocksList.length > 0 ? tableBlocksList : undefined,
    };
  }
  return null;
}

/**
 * Flatten tool_result `content` into a plain string.
 *
 * Claude Code emits two shapes for the content field:
 *   - string  — regular tool results (Bash, Read, Grep, …)
 *   - array of `web_search_result` objects  — WebSearch results
 *
 * Returns a flat "[N] Title – URL" list for web search results.
 */
function flattenToolResultContent(content: unknown): string {
  if (isString(content)) {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const lines: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const item = toRecord(content[i]);
    if (!item) {
      continue;
    }
    const title = isString(item.title) ? item.title : "";
    const url = isString(item.url) ? item.url : "";
    if (url) {
      lines.push(title ? `[${i + 1}] ${title} – ${url}` : `[${i + 1}] ${url}`);
    }
  }
  return lines.join("\n");
}

/** Parse a user-type event (tool results) into a SlackSegment. */
function parseUserEvent(event: Record<string, unknown>): SlackSegment | null {
  const msg = toRecord(event.message);
  if (!msg) {
    return null;
  }
  const content = Array.isArray(msg.content) ? msg.content : [];

  const parts: string[] = [];
  let hasError = false;

  for (const rawBlock of content) {
    const block = toRecord(rawBlock);
    // Handle both regular tool_result and web_search_tool_result blocks.
    if (!block || (block.type !== "tool_result" && block.type !== "web_search_tool_result")) {
      continue;
    }

    const isError = block.is_error === true;
    if (isError) {
      hasError = true;
    }

    const prefix = isError ? ":x: Error" : ":white_check_mark: Result";
    const resultText = flattenToolResultContent(block.content);
    const truncated = resultText.length > 500 ? `${resultText.slice(0, 500)}...` : resultText;
    if (!truncated) {
      parts.push(`${prefix}: (empty)`);
    } else {
      parts.push(`${prefix}:\n\`\`\`\n${truncated}\n\`\`\``);
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return {
    kind: "tool_result",
    text: parts.join("\n"),
    isError: hasError || undefined,
  };
}

/**
 * Parse a Claude Code stream-json event into a typed Slack segment.
 *
 * Claude Code emits complete messages (not Anthropic streaming deltas):
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}
 *   {"type":"result","result":"...","session_id":"..."}
 */
export function parseStreamEvent(event: Record<string, unknown>): SlackSegment | null {
  const type = event.type;
  if (type === "assistant") {
    return parseAssistantEvent(event);
  }
  if (type === "user") {
    return parseUserEvent(event);
  }
  return null;
}

// #endregion

// #region Text helpers

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/** Convert standard Markdown to Slack mrkdwn using slackify-markdown. */
export function markdownToSlack(text: string): string {
  return slackifyMarkdown(text);
}

/**
 * Regex that matches a complete markdown table:
 *   header row \n separator row \n zero-or-more data rows
 */
export const MARKDOWN_TABLE_RE = /\|.+\|\n\|[-: |]+\|\n(?:\|.+\|\n?)*/g;

/**
 * Extract all markdown tables from raw text.
 * Returns the cleaned text (each table replaced with a blank line) and
 * an array of raw table strings for `markdownTableToSlackBlock`.
 */
export function extractMarkdownTables(raw: string): {
  clean: string;
  tables: string[];
} {
  const tables: string[] = [];
  MARKDOWN_TABLE_RE.lastIndex = 0;
  const clean = raw.replace(MARKDOWN_TABLE_RE, (match) => {
    tables.push(match.trim());
    return "\n\n";
  });
  return {
    clean: clean.trim(),
    tables,
  };
}

/**
 * Convert a raw markdown table string into a Slack table block object.
 * Returns null if the input cannot be parsed into a valid table.
 */
export function markdownTableToSlackBlock(tableMarkdown: string): object | null {
  const allLines = tableMarkdown
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lines = allLines.filter((l) => !/^\|[-: |]+\|$/.test(l));
  if (lines.length < 1) {
    return null;
  }

  const parseRow = (line: string): string[] =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

  const rows = lines.map(parseRow);
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount < 1) {
    return null;
  }

  return {
    type: "table",
    rows: rows.map((row) => {
      const padded = row.slice();
      while (padded.length < colCount) {
        padded.push("");
      }
      return padded.map((cell) => ({
        type: "raw_text",
        text: cell,
      }));
    }),
  };
}

// #endregion

// #region File downloads

const DOWNLOADS_DIR = "/tmp/spa-downloads";

/** Check if a buffer starts with an HTML doctype or tag (indicates auth redirect, not a real file). */
export function looksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 256).toString("utf-8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Download a Slack-hosted file into a thread-scoped temp dir. */
export async function downloadSlackFile(
  url: string,
  filename: string,
  threadTs: string,
  botToken: string,
): Promise<Result<string>> {
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return Err(new Error(`Failed to download ${filename}: ${resp.status}`));
    }

    // Guard: if Slack returns HTML (auth page) instead of the actual file,
    // the bot token likely lacks the files:read scope.
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      return Err(
        new Error(
          `Download of ${filename} returned HTML instead of file data (Content-Type: ${contentType}). ` +
            "The bot token may be missing the files:read OAuth scope.",
        ),
      );
    }

    const buf = await resp.arrayBuffer();
    const buffer = Buffer.from(buf);

    // Defense-in-depth: even if Content-Type looks fine, check the actual bytes
    if (looksLikeHtml(buffer)) {
      return Err(
        new Error(
          `Download of ${filename} contains HTML despite Content-Type: ${contentType}. ` +
            "Slack likely returned an auth redirect page instead of the file.",
        ),
      );
    }

    const dir = `${DOWNLOADS_DIR}/${threadTs}`;
    mkdirSync(dir, {
      recursive: true,
    });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const localPath = `${dir}/${safeName}`;
    writeFileSync(localPath, buffer);
    return Ok(localPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Err(new Error(`Error downloading ${filename}: ${msg}`));
  }
}

// #endregion

// #region Cleanup

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_TIMESTAMP_PATH = `${DOWNLOADS_DIR}/.last-cleanup`;

/** Remove download directories older than 30 days. */
export function cleanupStaleDownloads(): void {
  if (!existsSync(DOWNLOADS_DIR)) {
    return;
  }
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - thirtyDaysMs;
  let removed = 0;
  try {
    for (const entry of readdirSync(DOWNLOADS_DIR)) {
      const entryPath = `${DOWNLOADS_DIR}/${entry}`;
      try {
        const stat = statSync(entryPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          rmSync(entryPath, {
            recursive: true,
            force: true,
          });
          removed++;
        }
      } catch {
        // skip entries we can't stat
      }
    }
  } catch {
    // ignore if dir disappeared
  }
  if (removed > 0) {
    console.log(`[spa] Cleaned up ${removed} stale download dir(s)`);
  }
}

/** Run cleanup only if at least 1 hour since last run. Persists timestamp to disk. */
export function runCleanupIfDue(): void {
  try {
    if (existsSync(CLEANUP_TIMESTAMP_PATH)) {
      const lastRun = Number.parseInt(readFileSync(CLEANUP_TIMESTAMP_PATH, "utf-8").trim(), 10);
      if (Date.now() - lastRun < CLEANUP_INTERVAL_MS) {
        return;
      }
    }
  } catch {
    // file missing or unreadable — run cleanup
  }

  cleanupStaleDownloads();

  try {
    mkdirSync(DOWNLOADS_DIR, {
      recursive: true,
    });
    writeFileSync(CLEANUP_TIMESTAMP_PATH, String(Date.now()));
  } catch {
    // non-fatal
  }
}

// #endregion

// #region Slack Block Kit — rich_text rendering

/**
 * Convert raw markdown to a plain-text string suitable for Slack notification
 * fallback text (push notifications, sidebar previews, screen readers).
 */
export function plainTextFallback(md: string): string {
  return md
    .replace(/^```[a-zA-Z0-9]*\n[\s\S]*?^```[ \t]*$/gm, "[code]")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^>\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Build a `rich_text` Block from an array of rich_text elements. */
function mkRichText(elements: object[]): Block {
  return Object.assign(
    {
      type: "rich_text",
    },
    {
      elements,
    },
  );
}

/** Build a `rich_text_preformatted` element wrapping a single text string. */
function mkPreformatted(code: string): object {
  return Object.assign(
    {
      type: "rich_text_preformatted",
    },
    {
      elements: [
        {
          type: "text",
          text: code,
        },
      ],
    },
  );
}

/**
 * Parse inline markdown into Slack rich_text inline element objects.
 *
 * Handles (in priority order):
 *   - Inline code:    `code`
 *   - Links:          [text](url)
 *   - Bold:           **text**
 *   - Strikethrough:  ~~text~~
 *   - Italic:         *text*
 *   - Plain text:     everything else
 */
export function parseInlineMarkdown(text: string): object[] {
  const result: object[] = [];
  const TOKEN_RE = /`([^`\n]+)`|\[([^\]]*)\]\(([^)]*)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;
  let lastIndex = 0;

  for (const match of text.matchAll(TOKEN_RE)) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      const plain = text.slice(lastIndex, matchIndex);
      if (plain) {
        result.push({
          type: "text",
          text: plain,
        });
      }
    }
    if (match[1] !== undefined) {
      result.push({
        type: "text",
        text: match[1],
        style: {
          code: true,
        },
      });
    } else if (match[2] !== undefined) {
      const linkText = match[2];
      const url = match[3] ?? "";
      if (linkText) {
        result.push({
          type: "link",
          url,
          text: linkText,
        });
      } else {
        result.push({
          type: "link",
          url,
        });
      }
    } else if (match[4] !== undefined) {
      result.push({
        type: "text",
        text: match[4],
        style: {
          bold: true,
        },
      });
    } else if (match[5] !== undefined) {
      result.push({
        type: "text",
        text: match[5],
        style: {
          strike: true,
        },
      });
    } else if (match[6] !== undefined) {
      result.push({
        type: "text",
        text: match[6],
        style: {
          italic: true,
        },
      });
    }
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining) {
      result.push({
        type: "text",
        text: remaining,
      });
    }
  }

  return result;
}

/**
 * Parse a non-code markdown text block into Slack rich_text element objects.
 *
 * Handles: bullet lists, ordered lists, blockquotes, ATX headers (#), and
 * regular paragraphs.
 */
export function parseMarkdownBlock(text: string): object[] {
  const elements: object[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)/);
    if (bulletMatch) {
      const listItems: object[] = [];
      while (i < lines.length) {
        const bm = lines[i].match(/^(\s*)([-*+])\s+(.*)/);
        if (!bm) {
          break;
        }
        listItems.push({
          type: "rich_text_section",
          elements: parseInlineMarkdown(bm[3]),
        });
        i++;
      }
      elements.push({
        type: "rich_text_list",
        style: "bullet",
        elements: listItems,
      });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const listItems: object[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*\d+\.\s+/, "");
        listItems.push({
          type: "rich_text_section",
          elements: parseInlineMarkdown(itemText),
        });
        i++;
      }
      elements.push({
        type: "rich_text_list",
        style: "ordered",
        elements: listItems,
      });
      continue;
    }

    const headerMatch = line.match(/^#{1,6}\s+(.*)/);
    if (headerMatch) {
      elements.push({
        type: "rich_text_section",
        elements: [
          {
            type: "text",
            text: headerMatch[1],
            style: {
              bold: true,
            },
          },
        ],
      });
      i++;
      continue;
    }

    if (/^> ?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^> ?/, ""));
        i++;
      }
      elements.push({
        type: "rich_text_quote",
        elements: parseInlineMarkdown(quoteLines.join("\n")),
      });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        break;
      }
      if (/^(\s*)([-*+])\s+/.test(l)) {
        break;
      }
      if (/^\s*\d+\.\s+/.test(l)) {
        break;
      }
      if (/^#{1,6}\s+/.test(l)) {
        break;
      }
      if (/^> ?/.test(l)) {
        break;
      }
      paraLines.push(l);
      i++;
    }

    if (paraLines.length > 0) {
      const inlineElms = parseInlineMarkdown(paraLines.join("\n"));
      if (inlineElms.length > 0) {
        elements.push({
          type: "rich_text_section",
          elements: inlineElms,
        });
      }
    }
  }

  return elements;
}

/**
 * Convert raw markdown text to an array of Slack `rich_text` Block objects.
 *
 * Why rich_text instead of section+mrkdwn?
 *   - `rich_text_preformatted` renders code fences at full message width and never
 *     triggers Slack's "See more" collapse, regardless of line count.
 *   - `rich_text_section` also uses the full message width.
 *
 * Strategy:
 *   1. Split on fenced code blocks (``` … ```).
 *   2. Each code fence → one `rich_text` block containing a `rich_text_preformatted` element.
 *   3. Each surrounding text segment → one `rich_text` block with section/list/quote elements.
 *   4. Unclosed code fences (mid-stream) → treated as preformatted content.
 */
export function markdownToRichTextBlocks(text: string): Block[] {
  if (!text.trim()) {
    return [];
  }

  const blocks: Block[] = [];
  const FENCE_RE = /^```([a-zA-Z0-9]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let lastIndex = 0;

  for (const match of text.matchAll(FENCE_RE)) {
    const matchIndex = match.index;

    if (matchIndex > lastIndex) {
      const before = text.slice(lastIndex, matchIndex).trim();
      if (before) {
        const elms = parseMarkdownBlock(before);
        if (elms.length > 0) {
          blocks.push(mkRichText(elms));
        }
      }
    }

    const codeContent = match[2].replace(/\n$/, "");
    if (codeContent) {
      blocks.push(
        mkRichText([
          mkPreformatted(codeContent),
        ]),
      );
    }

    lastIndex = matchIndex + match[0].length;
  }

  const remaining = text.slice(lastIndex);
  if (remaining.trim()) {
    const unclosedIdx = remaining.search(/^```[a-zA-Z0-9]*\n/m);
    if (unclosedIdx !== -1) {
      const beforeFence = remaining.slice(0, unclosedIdx).trim();
      if (beforeFence) {
        const elms = parseMarkdownBlock(beforeFence);
        if (elms.length > 0) {
          blocks.push(mkRichText(elms));
        }
      }
      const fenceNewline = remaining.indexOf("\n", unclosedIdx);
      const unclosedCode = fenceNewline !== -1 ? remaining.slice(fenceNewline + 1) : "";
      if (unclosedCode.trim()) {
        blocks.push(
          mkRichText([
            mkPreformatted(unclosedCode),
          ]),
        );
      }
    } else {
      const elms = parseMarkdownBlock(remaining.trim());
      if (elms.length > 0) {
        blocks.push(mkRichText(elms));
      }
    }
  }

  return blocks;
}

// #endregion

// Exclude `|` so we don't span across Slack mrkdwn `<url|label>` links.
export const PR_URL_REGEX = /https:\/\/github\.com\/[^\s<>)|]+\/pull\/\d+/g;
