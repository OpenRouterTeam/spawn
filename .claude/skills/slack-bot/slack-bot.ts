import App from "@slack/bolt";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Resolve our own bot user ID so we can skip our own messages
// ---------------------------------------------------------------------------

let BOT_USER_ID = "";

// ---------------------------------------------------------------------------
// State — thread-to-session mappings persisted to disk
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Claude Code helpers
// ---------------------------------------------------------------------------

const StreamEventSchema = v.object({
  type: v.string(),
});

const AssistantMessageSchema = v.object({
  type: v.literal("assistant"),
  message: v.object({
    content: v.array(
      v.object({
        type: v.string(),
        text: v.optional(v.string()),
      }),
    ),
  }),
});

const ResultSchema = v.object({
  type: v.literal("result"),
  session_id: v.string(),
});

const SYSTEM_PROMPT = `You are SPA (Spawn's Personal Agent), a Slack bot for the Spawn project (${GITHUB_REPO}).

Your primary job is to help manage GitHub issues based on Slack conversations:

1. **Create issues**: When a thread describes a bug, feature request, or task — create a GitHub issue with \`gh issue create --repo ${GITHUB_REPO}\`. Use a clear title and include the Slack context in the body.
2. **Update issues**: When a thread references an existing issue (by number like #123) — add comments, update labels, or close issues as appropriate using \`gh issue comment\`, \`gh issue edit\`, etc.
3. **Search issues**: When asked about existing issues, search with \`gh issue list --repo ${GITHUB_REPO}\` or \`gh issue view\`.
4. **General help**: Answer questions about the Spawn codebase, suggest fixes, or help triage.

Always use the \`gh\` CLI for GitHub operations. You are already authenticated.

When creating issues, include a footer: "_Filed from Slack by SPA_"

Below is the full Slack thread. The most recent message is the one you should respond to. Prior messages are context.`;

/**
 * Fetch full thread history from Slack and format as a prompt.
 */
async function buildThreadPrompt(
  client: InstanceType<typeof App.default>["client"],
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
    const text = stripMention(msg.text ?? "");
    if (!text) {
      continue;
    }
    lines.push(text);
  }

  return lines.join("\n\n");
}

/**
 * Run `claude -p` with stream-json output, collect assistant text,
 * and post chunked updates to a Slack thread.
 */
async function runClaudeAndStream(
  client: InstanceType<typeof App.default>["client"],
  channel: string,
  threadTs: string,
  prompt: string,
  sessionId: string | undefined,
): Promise<string | null> {
  const args = [
    "claude",
    "-p",
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

  args.push(prompt);

  console.log(`[spa] Starting claude session (thread=${threadTs}, resume=${sessionId ?? "new"})`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.env.REPO_ROOT ?? process.cwd(),
  });

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

        const base = v.safeParse(StreamEventSchema, parsed);
        if (!base.success) {
          continue;
        }

        // Extract assistant text
        const assistant = v.safeParse(AssistantMessageSchema, parsed);
        if (assistant.success) {
          for (const block of assistant.output.message.content) {
            if (block.type === "text" && block.text) {
              fullText += block.text;
            }
          }
        }

        // Capture session ID from result
        const resultEvent = v.safeParse(ResultSchema, parsed);
        if (resultEvent.success) {
          returnedSessionId = resultEvent.output.session_id;
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

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// ---------------------------------------------------------------------------
// Core handler — shared by app_mention and message events
// ---------------------------------------------------------------------------

async function handleThread(
  client: InstanceType<typeof App.default>["client"],
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

// ---------------------------------------------------------------------------
// Slack App
// ---------------------------------------------------------------------------

const app = new App.default({
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

// --- message: new thread replies in tracked threads trigger Claude ---
app.event("message", async ({ event, client }) => {
  if (!("channel" in event) || event.channel !== SLACK_CHANNEL_ID) {
    return;
  }

  // Only thread replies
  const threadTs = "thread_ts" in event && typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  if (!threadTs) {
    return;
  }

  // Skip our own messages
  if ("user" in event && event.user === BOT_USER_ID) {
    return;
  }
  if ("bot_id" in event && event.bot_id) {
    return;
  }
  if ("subtype" in event && event.subtype === "bot_message") {
    return;
  }

  // Only respond in threads we're already tracking
  const mapping = findMapping(state, event.channel, threadTs);
  if (!mapping) {
    return;
  }

  const ts = "ts" in event && typeof event.ts === "string" ? event.ts : "";
  if (!ts) {
    return;
  }

  await handleThread(client, event.channel, threadTs, ts);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`[spa] Received ${signal}, shutting down...`);

  for (const [threadTs, run] of activeRuns) {
    console.log(`[spa] Killing active run for thread ${threadTs}`);
    run.proc.kill("SIGTERM");
  }

  saveState(state);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
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
