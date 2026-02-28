// SPA (Spawn's Personal Agent) — Slack bot entry point.
// Pipes Slack threads into Claude Code sessions and streams responses back.

import type { SectionBlock, ContextBlock, KnownBlock } from "@slack/bolt";
import { App } from "@slack/bolt";
import * as v from "valibot";
import { toRecord, isString } from "@openrouter/spawn-shared";
import type { State, ToolCall } from "./helpers";
import {
  ResultSchema,
  loadState,
  saveState,
  findMapping,
  addMapping,
  parseStreamEvent,
  stripMention,
  downloadSlackFile,
  runCleanupIfDue,
  formatToolStats,
  formatToolHistory,
} from "./helpers";

type SlackClient = InstanceType<typeof App>["client"];

// #region Environment

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "OpenRouterTeam/spawn";

for (const [name, value] of Object.entries({
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_CHANNEL_ID,
})) {
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
const state: State = stateResult.ok
  ? stateResult.data
  : {
      mappings: [],
    };
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

**Duplicate check — MANDATORY before creating any issue.** Before filing a new issue, you MUST:
1. Extract 3-5 keywords from the proposed issue (e.g. "delete", "cloud", "hetzner", "script missing").
2. Search BOTH open AND closed issues for matches:
   \`gh issue list --repo ${GITHUB_REPO} --state all --search "KEYWORDS" --limit 20\`
3. If a matching closed issue exists, check whether the fix is still present in the codebase:
   - Use Grep/Read to verify the relevant code — was it reverted, removed, or is it still there?
   - If the fix is still in place → the issue is already resolved. Tell the Slack thread "This was already fixed in #N" and do NOT create a duplicate.
   - If the fix was reverted or the problem recurred → reopen the existing issue with \`gh issue reopen N --comment "Regression: ..."\` instead of creating a new one.
4. If a matching open issue exists → do NOT create a duplicate. Instead comment on the existing issue if the Slack thread adds new context, and link it in Slack.
5. Only create a new issue if no existing issue (open or closed) covers the same problem.

**Issue title format — MANDATORY.** Before creating an issue, read the issue templates in \`.github/ISSUE_TEMPLATE/\` to determine the correct title prefix, labels, and required fields. Each template specifies a bracket prefix (e.g. \`[Bug]:\`, \`[CLI]:\`) — always use the matching one. Apply the labels defined in the template's \`labels:\` field.

When creating issues, include a footer: "_Filed from Slack by SPA_"

Below is the full Slack thread. The most recent message is the one you should respond to. Prior messages are context.`;

/** Slack attachment shape (secondary content below blocks). */
interface SlackAttachment {
  color?: string;
  text: string;
  mrkdwn_in?: string[];
}

/**
 * Post a new message or update an existing one. Returns the message timestamp.
 * Optional `attachments` adds expandable secondary content below blocks.
 */
async function postOrUpdate(
  client: SlackClient,
  channel: string,
  threadTs: string,
  existingTs: string | undefined,
  fallback: string,
  blocks: KnownBlock[],
  attachments?: SlackAttachment[],
): Promise<string | undefined> {
  if (!existingTs) {
    const msg = await client.chat
      .postMessage({
        channel,
        thread_ts: threadTs,
        text: fallback,
        blocks,
        attachments,
      })
      .catch(() => null);
    return msg?.ts;
  }
  await client.chat
    .update({
      channel,
      ts: existingTs,
      text: fallback,
      blocks,
      attachments: attachments ?? [],
    })
    .catch(() => {});
  return existingTs;
}

/**
 * Fetch full thread history from Slack and format as a prompt.
 */
async function buildThreadPrompt(client: SlackClient, channel: string, threadTs: string): Promise<string> {
  const result = await client.conversations.replies({
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 100,
  });

  const messages = result.messages ?? [];
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.user === BOT_USER_ID) {
      continue;
    }
    if (msg.bot_id) {
      continue;
    }

    const parts: string[] = [];

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
        const name = isString(f.name) ? f.name : "file";
        const url = isString(f.url_private_download) ? f.url_private_download : "";
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
        const title = isString(a.title) ? a.title : "";
        const attText = isString(a.text) ? a.text : "";
        const fallback = isString(a.fallback) ? a.fallback : "";
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

// ─── Block Kit message builder ─────────────────────────────────────────────

const MAX_SECTION_LEN = 2900; // Slack section block text limit is 3000

interface BuildBlocksInput {
  mainText: string;
  currentTool: ToolCall | null;
  toolCounts: ReadonlyMap<string, number>;
  toolHistory: readonly ToolCall[];
  loading: boolean;
}

interface BuildBlocksResult {
  blocks: KnownBlock[];
  attachments: SlackAttachment[];
}

/**
 * Build Block Kit blocks with redesigned tool footer:
 *  1. Section: main response text
 *  2. Context: latest tool call (swapped, not appended)
 *  3. Context: compact stats line (1× Bash, 4× Read, ...)
 *  4. Attachment: full ordered tool history (expandable in Slack)
 */
function buildBlocks(input: BuildBlocksInput): BuildBlocksResult {
  const { mainText, currentTool, toolCounts, toolHistory, loading } = input;
  const blocks: KnownBlock[] = [];
  const attachments: SlackAttachment[] = [];

  // 1. Main text section
  if (mainText) {
    const display = mainText.length > MAX_SECTION_LEN ? `...${mainText.slice(-MAX_SECTION_LEN)}` : mainText;
    const section: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: display,
      },
    };
    blocks.push(section);
  }

  // 2. Current tool detail — shows only the LATEST tool (swapped each update)
  if (currentTool) {
    const icon = currentTool.errored ? ":x:" : ":hammer_and_wrench:";
    let toolLine = `${icon} *${currentTool.name}*`;
    if (currentTool.hint) {
      toolLine += ` \`${currentTool.hint}\``;
    }
    if (loading) {
      toolLine += " :openrouter-loading:";
    }
    const ctx: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: toolLine,
        },
      ],
    };
    blocks.push(ctx);
  } else if (loading && !mainText) {
    const ctx: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":openrouter-loading:",
        },
      ],
    };
    blocks.push(ctx);
  }

  // 3. Stats line — compact tool usage counts
  if (toolCounts.size > 0) {
    const stats = formatToolStats(toolCounts);
    const ctx: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: stats,
        },
      ],
    };
    blocks.push(ctx);
  }

  // 4. Expandable tool history — Slack auto-collapses long attachment text
  if (!loading && toolHistory.length > 1) {
    const historyText = formatToolHistory(toolHistory);
    attachments.push({
      color: "#808080",
      text: historyText,
      mrkdwn_in: ["text"],
    });
  }

  return { blocks, attachments };
}

/**
 * Run `claude -p` with stream-json output.
 * Text -> main section block. Tools -> compact context footer.
 */
async function runClaudeAndStream(
  client: SlackClient,
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

  proc.stdin.write(prompt);
  proc.stdin.end();

  activeRuns.set(threadTs, {
    proc,
    startedAt: Date.now(),
  });

  // ─── Streaming state ─────────────────────────────────────────────────
  let mainText = "";
  const toolHistory: ToolCall[] = [];
  const toolCounts = new Map<string, number>();
  let currentTool: ToolCall | null = null;
  let msgTs: string | undefined;
  let returnedSessionId: string | null = null;
  let hasOutput = false;
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL_MS = 2000;
  let dirty = false;

  /** Post or update the Slack message with current blocks. */
  async function updateMessage(loading: boolean): Promise<void> {
    const { blocks, attachments } = buildBlocks({
      mainText,
      currentTool,
      toolCounts,
      toolHistory,
      loading,
    });
    if (blocks.length === 0) {
      return;
    }
    const totalTools = toolHistory.length;
    const fallback = mainText || `Working... (${totalTools} tool${totalTools === 1 ? "" : "s"})`;
    hasOutput = true;
    msgTs = await postOrUpdate(
      client,
      channel,
      threadTs,
      msgTs,
      fallback,
      blocks,
      attachments.length > 0 ? attachments : undefined,
    );
    dirty = false;
  }

  // ─── Stream processing ────────────────────────────────────────────────
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

        const segment = parseStreamEvent(obj);
        if (!segment) {
          continue;
        }

        if (segment.kind === "text") {
          mainText += segment.text;
          dirty = true;
        } else if (segment.kind === "tool_use" && segment.toolName) {
          const tool: ToolCall = {
            name: segment.toolName,
            hint: segment.toolHint ?? "",
          };
          toolHistory.push(tool);
          currentTool = tool;
          toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);
          dirty = true;
        } else if (segment.kind === "tool_result" && segment.isError && currentTool) {
          currentTool.errored = true;
          dirty = true;
        }
      }

      // Throttled Slack update
      const now = Date.now();
      if (dirty && now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
        await updateMessage(true);
        lastUpdateTime = now;
      }
    }
  } finally {
    activeRuns.delete(threadTs);
  }

  // ─── Final update ─────────────────────────────────────────────────────

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !hasOutput && !mainText) {
    console.error(`[spa] claude exited ${exitCode}: ${stderr}`);
    const errSection: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:x: Claude Code errored (exit ${exitCode}):\n\`\`\`\n${stderr.slice(0, 1500)}\n\`\`\``,
      },
    };
    const errBlocks: KnownBlock[] = [
      errSection,
    ];
    msgTs = await postOrUpdate(client, channel, threadTs, msgTs, "Error", errBlocks);
    return null;
  }

  // Final update — remove loading indicator
  await updateMessage(false);

  if (!hasOutput && !mainText) {
    const doneCtx: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":white_check_mark: Done (no text output)",
        },
      ],
    };
    const doneBlocks: KnownBlock[] = [
      doneCtx,
    ];
    msgTs = await postOrUpdate(client, channel, threadTs, msgTs, "Done", doneBlocks);
  }

  console.log(`[spa] Claude done (thread=${threadTs}, session=${returnedSessionId})`);
  return returnedSessionId;
}

// #endregion

// #region Core handler

async function handleThread(client: SlackClient, channel: string, threadTs: string, eventTs: string): Promise<void> {
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

  const prompt = await buildThreadPrompt(client, channel, threadTs);
  if (!prompt) {
    return;
  }

  const existing = findMapping(state, channel, threadTs);

  await client.reactions
    .add({
      channel,
      timestamp: eventTs,
      name: "eyes",
    })
    .catch(() => {});

  const newSessionId = await runClaudeAndStream(client, channel, threadTs, prompt, existing?.sessionId);

  // Save session mapping
  if (newSessionId && !existing) {
    const r = addMapping(state, {
      channel,
      threadTs,
      sessionId: newSessionId,
      createdAt: new Date().toISOString(),
    });
    if (!r.ok) {
      console.error(`[spa] ${r.error.message}`);
    }
  } else if (newSessionId && existing) {
    existing.sessionId = newSessionId;
    const r = saveState(state);
    if (!r.ok) {
      console.error(`[spa] ${r.error.message}`);
    }
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
  if (!r.ok) {
    console.error(`[spa] ${r.error.message}`);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// #endregion

// #region Start

(async () => {
  runCleanupIfDue();

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
