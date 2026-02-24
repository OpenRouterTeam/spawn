import { App } from "@slack/bolt";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";

// #region Environment

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "OpenRouterTeam/spawn";

const REQUIRED_VARS = {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_CHANNEL_ID,
};

for (const [name, value] of Object.entries(REQUIRED_VARS)) {
  if (!value) {
    console.error(`ERROR: ${name} env var is required`);
    process.exit(1);
  }
}

// #endregion

// #region Bot identity

let BOT_USER_ID = "";

// #endregion

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

type Mapping = v.InferOutput<typeof MappingSchema>;
type State = v.InferOutput<typeof StateSchema>;

function loadState(): State {
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

function saveState(s: State): void {
  const dir = dirname(STATE_PATH);
  mkdirSync(dir, {
    recursive: true,
  });
  writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`);
}

function findMapping(s: State, channel: string, threadTs: string): Mapping | undefined {
  return s.mappings.find((m) => m.channel === channel && m.threadTs === threadTs);
}

function addMapping(s: State, mapping: Mapping): void {
  s.mappings.push(mapping);
  saveState(s);
}

const state = loadState();

// Active Claude Code processes — keyed by threadTs
const activeRuns = new Map<
  string,
  {
    proc: ReturnType<typeof Bun.spawn>;
    startedAt: number;
  }
>();

// #endregion

// #region Claude Code helpers

const ResultSchema = v.object({
  type: v.literal("result"),
  session_id: v.string(),
});

function toObj(val: unknown): Record<string, unknown> | null {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    return null;
  }
  // val is narrowed to `object` — safe to index
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) {
    obj[k] = v;
  }
  return obj;
}

/**
 * Format a Claude Code stream-json event into Slack-friendly text, or null to skip.
 *
 * Claude Code emits complete messages (not Anthropic streaming deltas):
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","content":"..."}]}}
 *   {"type":"result","result":"...","session_id":"..."}
 */
function formatStreamEvent(event: Record<string, unknown>): string | null {
  const type = event.type;

  // Assistant messages — contain text, tool_use, or thinking blocks
  if (type === "assistant") {
    const msg = toObj(event.message);
    if (!msg) {
      return null;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    const parts: string[] = [];

    for (const rawBlock of content) {
      const block = toObj(rawBlock);
      if (!block) {
        continue;
      }

      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }

      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = toObj(block.input);
        // Show a short summary of the tool input
        let summary = "";
        if (input) {
          const cmd = typeof input.command === "string" ? input.command : null;
          const pattern = typeof input.pattern === "string" ? input.pattern : null;
          const filePath = typeof input.file_path === "string" ? input.file_path : null;
          const hint = cmd ?? pattern ?? filePath;
          if (hint) {
            const short = hint.length > 80 ? `${hint.slice(0, 80)}...` : hint;
            summary = ` \`${short}\``;
          }
        }
        parts.push(`\n:hammer_and_wrench: *${block.name}*${summary}\n`);
      }
    }

    if (parts.length === 0) {
      return null;
    }
    return parts.join("");
  }

  // User messages — contain tool_result blocks
  if (type === "user") {
    const msg = toObj(event.message);
    if (!msg) {
      return null;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    const parts: string[] = [];

    for (const rawBlock of content) {
      const block = toObj(rawBlock);
      if (!block || block.type !== "tool_result") {
        continue;
      }
      const isError = block.is_error === true;
      const prefix = isError ? ":x: Error" : ":white_check_mark: Result";
      const resultText = typeof block.content === "string" ? block.content : "";
      const truncated = resultText.length > 500 ? `${resultText.slice(0, 500)}...` : resultText;
      if (!truncated) {
        parts.push(`${prefix}: (empty)\n`);
      } else {
        parts.push(`${prefix}:\n\`\`\`\n${truncated}\n\`\`\`\n`);
      }
    }

    if (parts.length === 0) {
      return null;
    }
    return parts.join("");
  }

  return null;
}

const SYSTEM_PROMPT = `You are SPA (Spawn's Personal Agent), a Slack bot for the Spawn project (${GITHUB_REPO}).

Your primary job is to help manage GitHub issues based on Slack conversations:

1. **Create issues**: When a thread describes a bug, feature request, or task — create a GitHub issue with \`gh issue create --repo ${GITHUB_REPO}\`. Use a clear title and include the Slack context in the body.
2. **Update issues**: When a thread references an existing issue (by number like #123) — add comments, update labels, or close issues as appropriate using \`gh issue comment\`, \`gh issue edit\`, etc.
3. **Search issues**: When asked about existing issues, search with \`gh issue list --repo ${GITHUB_REPO}\` or \`gh issue view\`.
4. **General help**: Answer questions about the Spawn codebase, suggest fixes, or help triage.

Always use the \`gh\` CLI for GitHub operations. You are already authenticated.

**Issue title format — MANDATORY.** Before creating an issue, read the issue templates in \`.github/ISSUE_TEMPLATE/\` to determine the correct title prefix, labels, and required fields. Each template specifies a bracket prefix (e.g. \`[Bug]:\`, \`[CLI]:\`) — always use the matching one. Apply the labels defined in the template's \`labels:\` field.

When creating issues, include a footer: "_Filed from Slack by SPA_"

Below is the full Slack thread. The most recent message is the one you should respond to. Prior messages are context.`;

const DOWNLOADS_DIR = "/tmp/spa-downloads";

/** Download a Slack-hosted file into a thread-scoped temp dir. Returns the local path or null. */
async function downloadSlackFile(url: string, filename: string, threadTs: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
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

/** Remove download directories older than 30 days. */
function cleanupStaleDownloads(): void {
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

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_TIMESTAMP_PATH = `${DOWNLOADS_DIR}/.last-cleanup`;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Run cleanup only if at least 1 hour since last run. Persists timestamp to disk. */
function runCleanupIfDue(): void {
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

/** Start the hourly cleanup schedule. */
function startCleanupSchedule(): void {
  runCleanupIfDue();
  cleanupTimer = setInterval(runCleanupIfDue, CLEANUP_INTERVAL_MS);
}

/**
 * Fetch full thread history from Slack and format as a prompt.
 */
async function buildThreadPrompt(
  client: InstanceType<typeof App>["client"],
  channel: string,
  threadTs: string,
): Promise<string> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 100,
  });

  const messages = result.messages ?? [];
  const lines: string[] = [];

  for (const msg of messages) {
    // Skip our own bot messages
    if (msg.user === BOT_USER_ID) {
      continue;
    }
    if (msg.bot_id) {
      continue;
    }

    const parts: string[] = [];

    // Message text
    const text = stripMention(msg.text ?? "");
    if (text) {
      parts.push(text);
    }

    // Files (images, docs, etc.) — download to local tmp
    if (msg.files && Array.isArray(msg.files)) {
      for (const file of msg.files) {
        const f = toObj(file);
        if (!f) {
          continue;
        }
        const name = typeof f.name === "string" ? f.name : "file";
        const url = typeof f.url_private_download === "string" ? f.url_private_download : "";
        if (!url) {
          continue;
        }
        const localPath = await downloadSlackFile(url, name, threadTs);
        if (localPath) {
          parts.push(`[File: ${name}] → ${localPath}`);
        }
      }
    }

    // Attachments (link unfurls, bot cards)
    if (msg.attachments && Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        const a = toObj(att);
        if (!a) {
          continue;
        }
        const title = typeof a.title === "string" ? a.title : "";
        const attText = typeof a.text === "string" ? a.text : "";
        const fallback = typeof a.fallback === "string" ? a.fallback : "";
        const content = title || attText || fallback;
        if (content) {
          parts.push(`[Attachment: ${content}]`);
        }
      }
    }

    if (parts.length > 0) {
      lines.push(parts.join("\n"));
    }
  }

  return lines.join("\n\n");
}

/**
 * Run `claude -p` with stream-json output, collect assistant text,
 * and post chunked updates to a Slack thread.
 */
async function runClaudeAndStream(
  client: InstanceType<typeof App>["client"],
  channel: string,
  threadTs: string,
  prompt: string,
  sessionId: string | undefined,
): Promise<string | null> {
  const args = [
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Pass prompt via stdin to avoid CLI flag parsing issues with user content
  args.push("-");

  console.log(`[spa] Starting claude session (thread=${threadTs}, resume=${sessionId ?? "new"})`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    cwd: process.env.REPO_ROOT ?? process.cwd(),
  });

  // Write prompt to stdin and close
  proc.stdin.write(prompt);
  proc.stdin.end();

  activeRuns.set(threadTs, {
    proc,
    startedAt: Date.now(),
  });

  // Post initial "thinking" message
  const thinkingMsg = await client.chat
    .postMessage({
      channel,
      thread_ts: threadTs,
      text: ":brain: Thinking...",
    })
    .catch(() => null);

  const updateTs = thinkingMsg?.ts;
  let fullText = "";
  let lastUpdateLen = 0;
  let returnedSessionId: string | null = null;

  // Throttle Slack updates — update at most every 2s
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL_MS = 2000;
  const MAX_MSG_LEN = 3900; // Slack limit ~4000, leave room

  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, {
        stream: true,
      });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const obj = toObj(parsed);
        if (!obj) {
          continue;
        }

        // Capture session ID from result event
        const resultEvent = v.safeParse(ResultSchema, obj);
        if (resultEvent.success) {
          returnedSessionId = resultEvent.output.session_id;
        }

        // Format event for Slack display
        const segment = formatStreamEvent(obj);
        if (segment) {
          fullText += segment;
        }
      }

      // Throttled Slack update
      const now = Date.now();
      if (updateTs && fullText.length > lastUpdateLen && now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
        const displayText = fullText.length > MAX_MSG_LEN ? `...${fullText.slice(-MAX_MSG_LEN)}` : fullText;

        await client.chat
          .update({
            channel,
            ts: updateTs,
            text: displayText,
          })
          .catch(() => {});

        lastUpdateLen = fullText.length;
        lastUpdateTime = now;
      }
    }
  } finally {
    activeRuns.delete(threadTs);
  }

  // Read stderr for errors
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !fullText) {
    console.error(`[spa] claude exited ${exitCode}: ${stderr}`);
    if (updateTs) {
      await client.chat
        .update({
          channel,
          ts: updateTs,
          text: `:x: Claude Code errored (exit ${exitCode}):\n\`\`\`\n${stderr.slice(0, 1500)}\n\`\`\``,
        })
        .catch(() => {});
    }
    return null;
  }

  // Final update with complete text
  if (updateTs && fullText) {
    const displayText = fullText.length > MAX_MSG_LEN ? `...${fullText.slice(-MAX_MSG_LEN)}` : fullText;

    await client.chat
      .update({
        channel,
        ts: updateTs,
        text: displayText,
      })
      .catch(() => {});
  }

  if (!fullText && updateTs) {
    await client.chat
      .update({
        channel,
        ts: updateTs,
        text: ":white_check_mark: Done (no text output)",
      })
      .catch(() => {});
  }

  console.log(`[spa] Claude done (thread=${threadTs}, session=${returnedSessionId}, len=${fullText.length})`);

  return returnedSessionId;
}

// #endregion

// #region Text helpers

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// #endregion

// #region Core handler

async function handleThread(
  client: InstanceType<typeof App>["client"],
  channel: string,
  threadTs: string,
  eventTs: string,
): Promise<void> {
  // Prevent concurrent runs on the same thread
  if (activeRuns.has(threadTs)) {
    await client.reactions
      .add({
        channel,
        timestamp: eventTs,
        name: "hourglass_flowing_sand",
      })
      .catch(() => {});
    return;
  }

  // Build prompt from full thread (skipping bot messages)
  const prompt = await buildThreadPrompt(client, channel, threadTs);
  if (!prompt) {
    return;
  }

  // Check for existing session to resume
  const existing = findMapping(state, channel, threadTs);

  await client.reactions
    .add({
      channel,
      timestamp: eventTs,
      name: "robot_face",
    })
    .catch(() => {});

  // Run Claude Code and stream back
  const sessionId = await runClaudeAndStream(client, channel, threadTs, prompt, existing?.sessionId);

  // Save session mapping
  if (sessionId && !existing) {
    addMapping(state, {
      channel,
      threadTs,
      sessionId,
      createdAt: new Date().toISOString(),
    });
  } else if (sessionId && existing) {
    existing.sessionId = sessionId;
    saveState(state);
  }
}

// #endregion

// #region Slack App

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: "INFO",
});

// --- app_mention: @Spawnis triggers a Claude run on this thread ---
app.event("app_mention", async ({ event, client }) => {
  if (event.channel !== SLACK_CHANNEL_ID) {
    return;
  }
  const threadTs = event.thread_ts ?? event.ts;
  await handleThread(client, event.channel, threadTs, event.ts);
});

// #endregion

// #region Graceful shutdown

function shutdown(signal: string): void {
  console.log(`[spa] Received ${signal}, shutting down...`);

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }

  for (const [threadTs, run] of activeRuns) {
    console.log(`[spa] Killing active run for thread ${threadTs}`);
    run.proc.kill("SIGTERM");
  }

  saveState(state);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// #endregion

// #region Start

(async () => {
  startCleanupSchedule();

  // Resolve our own bot user ID
  const authResult = await app.client.auth.test({
    token: SLACK_BOT_TOKEN,
  });
  BOT_USER_ID = authResult.user_id ?? "";
  if (BOT_USER_ID) {
    console.log(`[spa] Bot user ID: ${BOT_USER_ID}`);
  } else {
    console.warn("[spa] Could not resolve bot user ID — may echo own messages");
  }

  await app.start();
  console.log(`[spa] Running (channel=${SLACK_CHANNEL_ID}, repo=${GITHUB_REPO})`);
})();
// #endregion
