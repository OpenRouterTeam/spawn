// SPA (Spawn's Personal Agent) — Slack bot entry point.
// Pipes Slack threads into Claude Code sessions and streams responses back.

import { App } from "@slack/bolt";
import * as v from "valibot";
import { toRecord } from "@openrouter/spawn-shared";
import {
  type State,
  type Mapping,
  ResultSchema,
  loadState,
  saveState,
  findMapping,
  addMapping,
  parseStreamEvent,
  stripMention,
  downloadSlackFile,
  runCleanupIfDue,
} from "./helpers";

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

const stateResult = loadState();
const state: State = stateResult.ok ? stateResult.data : { mappings: [] };
if (!stateResult.ok) {
  console.warn(`[spa] ${stateResult.error.message}, starting fresh`);
}

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
        const f = toRecord(file);
        if (!f) {
          continue;
        }
        const name = typeof f.name === "string" ? f.name : "file";
        const url = typeof f.url_private_download === "string" ? f.url_private_download : "";
        if (!url) {
          continue;
        }
        const dlResult = await downloadSlackFile(url, name, threadTs, SLACK_BOT_TOKEN);
        if (dlResult.ok) {
          parts.push(`[File: ${name}] → ${dlResult.data}`);
        } else {
          console.error(`[spa] ${dlResult.error.message}`);
        }
      }
    }

    // Attachments (link unfurls, bot cards)
    if (msg.attachments && Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        const a = toRecord(att);
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

  let currentMsgTs = thinkingMsg?.ts;
  let currentText = "";
  let returnedSessionId: string | null = null;
  let hasOutput = false;

  // Throttle Slack updates — update at most every 2s
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL_MS = 2000;
  const MAX_MSG_LEN = 3800; // Slack limit ~4000, leave room for formatting

  /** Update the current Slack message, or post a new one if at limit. */
  async function flushToSlack(text: string, forceNew = false): Promise<void> {
    if (!text) {
      return;
    }
    hasOutput = true;

    // Need a new message if text would exceed limit or forced
    if (forceNew || !currentMsgTs || text.length > MAX_MSG_LEN) {
      // If there's leftover text in the current message, finalize it first
      if (currentMsgTs && currentText) {
        await client.chat
          .update({
            channel,
            ts: currentMsgTs,
            text: currentText.slice(0, MAX_MSG_LEN),
          })
          .catch(() => {});
      }

      // Post a new message
      const newMsg = await client.chat
        .postMessage({
          channel,
          thread_ts: threadTs,
          text: text.slice(0, MAX_MSG_LEN),
        })
        .catch(() => null);

      currentMsgTs = newMsg?.ts;
      currentText = text.slice(0, MAX_MSG_LEN);
      return;
    }

    await client.chat
      .update({
        channel,
        ts: currentMsgTs,
        text: text.slice(0, MAX_MSG_LEN),
      })
      .catch(() => {});
    currentText = text.slice(0, MAX_MSG_LEN);
  }

  // Accumulates text for the current "section" (consecutive text blocks)
  let pendingText = "";

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

        const obj = toRecord(parsed);
        if (!obj) {
          continue;
        }

        // Capture session ID from result event
        const resultEvent = v.safeParse(ResultSchema, obj);
        if (resultEvent.success) {
          returnedSessionId = resultEvent.output.session_id;
        }

        // Parse event into typed segment
        const segment = parseStreamEvent(obj);
        if (!segment) {
          continue;
        }

        if (segment.kind === "text") {
          pendingText += segment.text;
        } else {
          // tool_use and tool_result get their own messages
          if (pendingText) {
            await flushToSlack(pendingText);
            pendingText = "";
          }
          await flushToSlack(segment.text, true);
        }
      }

      // Throttled update for accumulated text
      const now = Date.now();
      if (pendingText && now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
        await flushToSlack(pendingText);
        lastUpdateTime = now;
      }
    }
  } finally {
    activeRuns.delete(threadTs);
  }

  // Flush any remaining text
  if (pendingText) {
    await flushToSlack(pendingText);
  }

  // Read stderr for errors
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !hasOutput) {
    console.error(`[spa] claude exited ${exitCode}: ${stderr}`);
    if (currentMsgTs) {
      await client.chat
        .update({
          channel,
          ts: currentMsgTs,
          text: `:x: Claude Code errored (exit ${exitCode}):\n\`\`\`\n${stderr.slice(0, 1500)}\n\`\`\``,
        })
        .catch(() => {});
    }
    return null;
  }

  if (!hasOutput && currentMsgTs) {
    await client.chat
      .update({
        channel,
        ts: currentMsgTs,
        text: ":white_check_mark: Done (no text output)",
      })
      .catch(() => {});
  }

  console.log(`[spa] Claude done (thread=${threadTs}, session=${returnedSessionId})`);

  return returnedSessionId;
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
  const newSessionId = await runClaudeAndStream(client, channel, threadTs, prompt, existing?.sessionId);

  // Save session mapping
  if (newSessionId && !existing) {
    const r = addMapping(state, {
      channel,
      threadTs,
      sessionId: newSessionId,
      createdAt: new Date().toISOString(),
    });
    if (!r.ok) console.error(`[spa] ${r.error.message}`);
  } else if (newSessionId && existing) {
    existing.sessionId = newSessionId;
    const r = saveState(state);
    if (!r.ok) console.error(`[spa] ${r.error.message}`);
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

  for (const [threadTs, run] of activeRuns) {
    console.log(`[spa] Killing active run for thread ${threadTs}`);
    run.proc.kill("SIGTERM");
  }

  const r = saveState(state);
  if (!r.ok) console.error(`[spa] ${r.error.message}`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// #endregion

// #region Start

(async () => {
  runCleanupIfDue();

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
