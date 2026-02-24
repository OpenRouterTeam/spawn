// SPA helpers — pure functions for parsing Claude Code stream events,
// Slack formatting, state management, and file download/cleanup.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";
import { toRecord } from "../../../cli/src/shared/type-guards";

// #region State

const STATE_PATH = process.env.STATE_PATH ?? `${process.env.HOME ?? "/root"}/.config/spawn/slack-issues.json`;

const MappingSchema = v.object({
  channel: v.string(),
  threadTs: v.string(),
  sessionId: v.string(),
  createdAt: v.string(),
});

const StateSchema = v.object({
  mappings: v.array(MappingSchema),
});

export type Mapping = v.InferOutput<typeof MappingSchema>;
export type State = v.InferOutput<typeof StateSchema>;

export function loadState(): State {
  try {
    if (!existsSync(STATE_PATH)) {
      return {
        mappings: [],
      };
    }
    const raw = readFileSync(STATE_PATH, "utf-8");
    const parsed = v.parse(StateSchema, JSON.parse(raw));
    return parsed;
  } catch {
    console.warn("[spa] Could not load state, starting fresh");
    return {
      mappings: [],
    };
  }
}

export function saveState(s: State): void {
  const dir = dirname(STATE_PATH);
  mkdirSync(dir, {
    recursive: true,
  });
  writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`);
}

export function findMapping(s: State, channel: string, threadTs: string): Mapping | undefined {
  return s.mappings.find((m) => m.channel === channel && m.threadTs === threadTs);
}

export function addMapping(s: State, mapping: Mapping): void {
  s.mappings.push(mapping);
  saveState(s);
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
    const msg = toRecord(event.message);
    if (!msg) {
      return null;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];

    // Check what kind of content blocks this message has
    const textParts: string[] = [];
    const toolParts: string[] = [];

    for (const rawBlock of content) {
      const block = toRecord(rawBlock);
      if (!block) {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }

      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = toRecord(block.input);
        let summary = "";
        if (input) {
          const hint =
            (typeof input.command === "string" ? input.command : null) ??
            (typeof input.pattern === "string" ? input.pattern : null) ??
            (typeof input.file_path === "string" ? input.file_path : null);
          if (hint) {
            const short = hint.length > 80 ? `${hint.slice(0, 80)}...` : hint;
            summary = ` \`${short}\``;
          }
        }
        toolParts.push(`:hammer_and_wrench: *${block.name}*${summary}`);
      }
    }

    // Tool use takes priority — it's a distinct event kind
    if (toolParts.length > 0) {
      return {
        kind: "tool_use",
        text: toolParts.join("\n"),
      };
    }
    if (textParts.length > 0) {
      return {
        kind: "text",
        text: textParts.join(""),
      };
    }
    return null;
  }

  if (type === "user") {
    const msg = toRecord(event.message);
    if (!msg) {
      return null;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    const parts: string[] = [];

    for (const rawBlock of content) {
      const block = toRecord(rawBlock);
      if (!block || block.type !== "tool_result") {
        continue;
      }
      const isError = block.is_error === true;
      const prefix = isError ? ":x: Error" : ":white_check_mark: Result";
      const resultText = typeof block.content === "string" ? block.content : "";
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
    };
  }

  return null;
}

// #endregion

// #region Text helpers

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// #endregion

// #region File downloads

const DOWNLOADS_DIR = "/tmp/spa-downloads";

/** Download a Slack-hosted file into a thread-scoped temp dir. Returns the local path or null. */
export async function downloadSlackFile(
  url: string,
  filename: string,
  threadTs: string,
  botToken: string,
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${botToken}`,
      },
    });
    if (!resp.ok) {
      console.error(`[spa] Failed to download ${filename}: ${resp.status}`);
      return null;
    }
    const dir = `${DOWNLOADS_DIR}/${threadTs}`;
    mkdirSync(dir, {
      recursive: true,
    });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const localPath = `${dir}/${safeName}`;
    const buf = await resp.arrayBuffer();
    writeFileSync(localPath, Buffer.from(buf));
    return localPath;
  } catch (err) {
    console.error(`[spa] Error downloading ${filename}:`, err);
    return null;
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
