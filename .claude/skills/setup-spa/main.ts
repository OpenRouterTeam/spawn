// SPA (Spawn's Personal Agent) — Slack bot entry point.
// Pipes Slack threads into Claude Code sessions and streams responses back.

import type { ActionsBlock, ContextBlock, KnownBlock, SectionBlock } from "@slack/bolt";
import type { Block } from "@slack/types";
import type { ToolCall } from "./helpers";

import { App } from "@slack/bolt";
import * as v from "valibot";
import { isString, toRecord } from "@openrouter/spawn-shared";
import {
  downloadSlackFile,
  findThread,
  formatToolStats,
  markdownToRichTextBlocks,
  openDb,
  PR_URL_REGEX,
  parseStreamEvent,
  plainTextFallback,
  ResultSchema,
  runCleanupIfDue,
  stripMention,
  updateThread,
  upsertThread,
} from "./helpers";

type SlackClient = InstanceType<typeof App>["client"];

// #region Environment

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "OpenRouterTeam/spawn";

for (const [name, value] of Object.entries({
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
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

const db = openDb();

// Active Claude Code processes — keyed by threadTs
const activeRuns = new Map<
  string,
  {
    proc: ReturnType<typeof Bun.spawn>;
    startedAt: number;
    cancelled?: boolean;
  }
>();

// Pending messages queued while a run is active — keyed by threadTs
// Each entry is a FIFO list of { channel, eventTs, userId? } waiting to be processed
const pendingQueues = new Map<
  string,
  Array<{
    channel: string;
    eventTs: string;
    userId?: string;
  }>
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

/**
 * Post a new message or update an existing one. Returns the message timestamp.
 *
 * `tableAttachments` is an optional list of Slack attachment objects each wrapping
 * a `{ type: "table", ... }` block — Slack only allows one table per message;
 * pass multiple elements to post extra tables separately.
 */
async function postOrUpdate(
  client: SlackClient,
  channel: string,
  threadTs: string,
  existingTs: string | undefined,
  fallback: string,
  blocks: (KnownBlock | Block)[],
  tableAttachments?: Record<string, unknown>[],
): Promise<string | undefined> {
  if (!existingTs) {
    const msg = await client.chat
      .postMessage(
        Object.assign(
          {
            channel,
            thread_ts: threadTs,
            text: fallback,
            blocks,
          },
          tableAttachments?.length
            ? {
                attachments: tableAttachments,
              }
            : {},
        ),
      )
      .catch(() => null);
    return msg?.ts;
  }
  await client.chat
    .update(
      Object.assign(
        {
          channel,
          ts: existingTs,
          text: fallback,
          blocks,
        },
        tableAttachments?.length
          ? {
              attachments: tableAttachments,
            }
          : {},
      ),
    )
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

interface BuildBlocksInput {
  /** Rich-text blocks for the main response text (0 or more). */
  textBlocks: Block[];
  currentTool: ToolCall | null;
  toolCounts: ReadonlyMap<string, number>;
  toolHistory: readonly ToolCall[];
  loading: boolean;
}

/**
 * Build a Slack "plan" block from the tool call history.
 *  - Completed tools → status: "complete"
 *  - Active (loading) tool → status: "in_progress"
 */
function buildPlanBlock(toolHistory: readonly ToolCall[], currentTool: ToolCall | null, loading: boolean): Block {
  const tasks = toolHistory.map((tool, i) => {
    const isActive = loading && tool === currentTool;
    const status = isActive ? "in_progress" : "complete";
    const taskTitle = tool.name;
    const detailText = tool.hint || tool.name;

    return Object.assign(
      {
        task_id: `task_${i}`,
        title: taskTitle,
        status,
      },
      {
        details: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                {
                  type: "text",
                  text: detailText,
                },
              ],
            },
          ],
        },
      },
    );
  });

  const planTitle = loading && currentTool ? currentTool.name : "Tool Calls";

  return Object.assign(
    {
      type: "plan",
    },
    {
      plan_id: "tool_calls",
      title: planTitle,
      tasks,
    },
  );
}

/**
 * Build Block Kit blocks for a single Slack message:
 *  1. Rich-text blocks supplied by caller
 *  2. Plan: all tool calls as tasks (complete / in_progress)
 *  3. Context: `:openrouter-loading:` + compact stats line combined
 */
function buildBlocks(input: BuildBlocksInput): (KnownBlock | Block)[] {
  const { textBlocks, currentTool, toolCounts, toolHistory, loading } = input;
  const blocks: (KnownBlock | Block)[] = [];

  blocks.push(...textBlocks);

  if (toolHistory.length > 0) {
    blocks.push(buildPlanBlock(toolHistory, currentTool, loading));
  }

  const hasStats = toolCounts.size > 0;
  if (loading || hasStats) {
    let footerText = loading ? ":openrouter-loading:" : "";
    if (hasStats) {
      const stats = formatToolStats(toolCounts);
      footerText = footerText ? `${footerText} ${stats}` : stats;
    }
    const ctx: ContextBlock = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: footerText,
        },
      ],
    };
    blocks.push(ctx);
  }

  return blocks;
}

/**
 * Run `claude -p` with stream-json output.
 * Text -> rich_text blocks. Tools -> plan block. Footer -> loading + stats.
 */
async function runClaudeAndStream(
  client: SlackClient,
  channel: string,
  threadTs: string,
  prompt: string,
  sessionId: string | undefined,
  userId?: string,
): Promise<{
  sessionId: string;
  prUrls: string[];
} | null> {
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
    env: {
      ...process.env,
      SLACK_CHANNEL_ID: channel,
      SLACK_THREAD_TS: threadTs,
      ...(userId
        ? {
            SLACK_USER_ID: userId,
          }
        : {}),
    },
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  activeRuns.set(threadTs, {
    proc,
    startedAt: Date.now(),
  });

  // --- Streaming state ---
  let currentSegmentText = ""; // text for the current in-progress Slack message
  let fullText = ""; // accumulates all text output across the entire run (for PR URL detection)
  const currentTableBlocks: object[] = []; // Slack table blocks extracted from markdown tables
  const toolHistory: ToolCall[] = [];
  const toolCounts = new Map<string, number>();

  // --- Immediate PR button ---
  const attemptedPrUrls = new Set<string>();
  let prBtnTs: string | undefined;
  let prButtonPromise: Promise<void> = Promise.resolve();

  /** Build a Slack actions block with buttons for the given PR URLs. */
  const buildPrButtonBlock = (urls: string[]): ActionsBlock => ({
    type: "actions",
    elements: urls.slice(0, 5).map((url, i) => ({
      type: "button",
      text: {
        type: "plain_text",
        text: `🔗 View PR${urls.length > 1 ? ` #${i + 1}` : ""}`,
        emoji: true,
      },
      url,
      action_id: `view_pr_${i}`,
    })),
  });

  /**
   * Fire-and-forget: if `fullText` contains PR URLs not yet attempted, immediately
   * post (or update) a button block so the team gets the link without waiting.
   */
  const firePrButtonIfNew = (): void => {
    PR_URL_REGEX.lastIndex = 0;
    const detected = new Set(fullText.match(PR_URL_REGEX) ?? []);
    const newUrls = [
      ...detected,
    ].filter((u) => !attemptedPrUrls.has(u));
    if (newUrls.length === 0) {
      return;
    }
    for (const u of newUrls) {
      attemptedPrUrls.add(u);
    }
    const allUrls = [
      ...attemptedPrUrls,
    ];
    prButtonPromise = postOrUpdate(client, channel, threadTs, prBtnTs, allUrls[0] ?? "PR ready for review", [
      buildPrButtonBlock(allUrls),
    ]).then((ts) => {
      if (ts) {
        prBtnTs = ts;
      }
    });
  };

  let currentTool: ToolCall | null = null;
  let msgTs: string | undefined;
  let returnedSessionId: string | null = null;
  let hasOutput = false;
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL_MS = 2000;
  let dirty = false;
  let wasCancelled = false;

  // Slack hard-caps messages at 50 blocks total. Reserve 3 slots for plan + context + actions.
  const MAX_TEXT_BLOCKS = 47;

  /**
   * Finalize the current text segment as a standalone Slack message (no footer/tools).
   * Resets currentSegmentText, currentTableBlocks, and msgTs so the next tools/text start fresh.
   *
   * When tools are in-flight at commit time, the plan block is finalized first as its own
   * standalone message (via updateMessage(false)), then plan state is reset so the next
   * batch of tool calls gets a fresh plan block. This produces interleaved messages:
   *   [plan₁] → [text] → [plan₂]
   */
  async function commitSegment(): Promise<void> {
    if (!currentSegmentText && currentTableBlocks.length === 0) {
      return;
    }

    if (toolHistory.length > 0) {
      const savedText = currentSegmentText;
      const savedTables = currentTableBlocks.splice(0);
      currentSegmentText = "";

      await updateMessage(false);

      toolHistory.length = 0;
      currentTool = null;
      toolCounts.clear();
      msgTs = undefined;

      currentSegmentText = savedText;
      currentTableBlocks.push(...savedTables);
    }

    const allBlocks = markdownToRichTextBlocks(currentSegmentText);
    const blocks = allBlocks.slice(0, MAX_TEXT_BLOCKS);
    const overflowBlocks = allBlocks.slice(MAX_TEXT_BLOCKS);

    const [firstTable, ...extraTables] = currentTableBlocks;
    const tableAtts = firstTable
      ? [
          {
            blocks: [
              firstTable,
            ],
          },
        ]
      : undefined;

    const fallbackText = plainTextFallback(currentSegmentText);
    const ts = await postOrUpdate(client, channel, threadTs, msgTs, fallbackText, blocks, tableAtts);
    if (ts) {
      hasOutput = true;
    }

    const overflowFallback = fallbackText.slice(0, 150);
    for (const block of overflowBlocks) {
      await postOrUpdate(client, channel, threadTs, undefined, overflowFallback, [
        block,
      ]);
    }

    for (const tb of extraTables) {
      await postOrUpdate(
        client,
        channel,
        threadTs,
        undefined,
        "",
        [],
        [
          {
            blocks: [
              tb,
            ],
          },
        ],
      );
    }

    msgTs = undefined;
    currentSegmentText = "";
    currentTableBlocks.length = 0;
  }

  /** Post or update the Slack message with current blocks. */
  async function updateMessage(loading: boolean): Promise<void> {
    const allTextBlocks = currentSegmentText ? markdownToRichTextBlocks(currentSegmentText) : [];

    const hasTools = toolHistory.length > 0;
    const primaryTextBlocks = loading
      ? allTextBlocks.slice(0, MAX_TEXT_BLOCKS)
      : hasTools
        ? []
        : allTextBlocks.slice(0, 1);
    const overflowTextBlocks = loading
      ? allTextBlocks.slice(MAX_TEXT_BLOCKS)
      : hasTools
        ? allTextBlocks
        : allTextBlocks.slice(1);

    const blocks = buildBlocks({
      textBlocks: primaryTextBlocks,
      currentTool,
      toolCounts,
      toolHistory,
      loading,
    });
    if (blocks.length === 0) {
      return;
    }

    if (loading) {
      const cancelBtn: ActionsBlock = {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "⛔ Cancel",
              emoji: true,
            },
            style: "danger",
            action_id: "cancel_run",
            value: JSON.stringify({
              channel,
              threadTs,
            }),
          },
        ],
      };
      blocks.push(cancelBtn);
    }

    if (!loading && wasCancelled) {
      const cancelledCtx: ContextBlock = {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ":octagonal_sign: _Cancelled_",
          },
        ],
      };
      blocks.push(cancelledCtx);
    }

    const totalTools = toolHistory.length;
    const fallback =
      plainTextFallback(currentSegmentText) || `Working... (${totalTools} tool${totalTools === 1 ? "" : "s"})`;
    hasOutput = true;
    msgTs = await postOrUpdate(client, channel, threadTs, msgTs, fallback, blocks);
    dirty = false;

    const overflowFallback = plainTextFallback(currentSegmentText).slice(0, 150);
    for (const block of overflowTextBlocks) {
      await postOrUpdate(client, channel, threadTs, undefined, overflowFallback, [
        block,
      ]);
    }

    if (!loading && currentTableBlocks.length > 0) {
      for (const tb of currentTableBlocks) {
        await postOrUpdate(
          client,
          channel,
          threadTs,
          undefined,
          "",
          [],
          [
            {
              blocks: [
                tb,
              ],
            },
          ],
        );
      }
      currentTableBlocks.length = 0;
    }
  }

  // --- Stream processing ---
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
          currentSegmentText += segment.text;
          fullText += segment.text;
          firePrButtonIfNew(); // post button immediately if a new PR URL just appeared
          if (segment.tableBlocks) {
            currentTableBlocks.push(...segment.tableBlocks);
          }
          dirty = true;
        } else if (segment.kind === "tool_use" && segment.toolName) {
          // Between tool batches: commit the previous text segment so the thread reads
          // [plan₁] → [text] → [plan₂] instead of one ever-growing plan block.
          // Before the first tool: keep text in currentSegmentText so it stays part of
          // the live tool message — avoids posting a seemingly-final answer while tools
          // are still running.
          if (currentSegmentText && toolHistory.length > 0) {
            await commitSegment();
            lastUpdateTime = 0;
          }
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
    wasCancelled = activeRuns.get(threadTs)?.cancelled ?? false;
    activeRuns.delete(threadTs);
  }

  // --- Final update ---

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !hasOutput && !currentSegmentText) {
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

  if (!hasOutput && !currentSegmentText) {
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

  // --- PR button: push to latest position ---
  await prButtonPromise;

  PR_URL_REGEX.lastIndex = 0;
  const prUrls = [
    ...new Set(fullText.match(PR_URL_REGEX) ?? []),
  ];
  if (prUrls.length > 0) {
    if (prBtnTs) {
      await client.chat
        .delete({
          channel,
          ts: prBtnTs,
        })
        .catch(() => {});
    }
    await postOrUpdate(client, channel, threadTs, undefined, prUrls[0] ?? "PR ready for review", [
      buildPrButtonBlock(prUrls),
    ]);
  }

  if (!returnedSessionId) {
    return null;
  }

  console.log(`[spa] Claude done (thread=${threadTs}, session=${returnedSessionId})`);
  return {
    sessionId: returnedSessionId,
    prUrls,
  };
}

// #endregion

// #region Core handler

async function handleThread(
  client: SlackClient,
  channel: string,
  threadTs: string,
  eventTs: string,
  userId?: string,
): Promise<void> {
  // If a run is already active on this thread, enqueue the message instead of dropping it
  if (activeRuns.has(threadTs)) {
    await client.reactions
      .add({
        channel,
        timestamp: eventTs,
        name: "hourglass_flowing_sand",
      })
      .catch(() => {});

    const queue = pendingQueues.get(threadTs) ?? [];
    queue.push({
      channel,
      eventTs,
      userId,
    });
    pendingQueues.set(threadTs, queue);
    console.log(`[spa] Queued message ${eventTs} for thread ${threadTs} (queue depth: ${queue.length})`);
    return;
  }

  const prompt = await buildThreadPrompt(client, channel, threadTs);
  if (!prompt) {
    return;
  }

  const existing = findThread(db, channel, threadTs);

  await client.reactions
    .add({
      channel,
      timestamp: eventTs,
      name: "eyes",
    })
    .catch(() => {});

  const result = await runClaudeAndStream(client, channel, threadTs, prompt, existing?.sessionId, userId);

  // Persist session mapping
  if (result && !existing) {
    upsertThread(db, {
      channel,
      threadTs,
      sessionId: result.sessionId,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      userId,
      prUrls: result.prUrls.length > 0 ? result.prUrls : undefined,
    });
  } else if (result && existing) {
    updateThread(db, channel, threadTs, {
      sessionId: result.sessionId,
      userId,
      lastActivityAt: new Date().toISOString(),
      prUrls: result.prUrls.length > 0 ? result.prUrls : undefined,
    });
  }

  // Drain the queue: process any messages that arrived while this run was active
  const queue = pendingQueues.get(threadTs);
  if (queue && queue.length > 0) {
    const next = queue.shift()!;
    if (queue.length === 0) {
      pendingQueues.delete(threadTs);
    }

    await client.reactions
      .remove({
        channel: next.channel,
        timestamp: next.eventTs,
        name: "hourglass_flowing_sand",
      })
      .catch(() => {});

    console.log(`[spa] Draining queue for thread ${threadTs}, processing ${next.eventTs}`);
    await handleThread(client, next.channel, threadTs, next.eventTs, next.userId);
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

// --- app_mention: @spa in any channel triggers a Claude run ---
app.event("app_mention", async ({ event, client }) => {
  const threadTs = event.thread_ts ?? event.ts;
  await handleThread(client, event.channel, threadTs, event.ts, event.user);
});

// --- message.im: direct messages to the bot ---
app.event("message", async ({ event, client }) => {
  const msg = toRecord(event);
  if (!msg) {
    return;
  }
  if (msg.channel_type !== "im") {
    return;
  }
  if (msg.bot_id || msg.subtype) {
    return;
  }
  if (msg.user === BOT_USER_ID) {
    return;
  }
  const ts = isString(msg.ts) ? msg.ts : undefined;
  if (!ts) {
    return;
  }
  const channel = isString(msg.channel) ? msg.channel : undefined;
  if (!channel) {
    return;
  }
  const threadTs = isString(msg.thread_ts) ? msg.thread_ts : ts;
  const userId = isString(msg.user) ? msg.user : undefined;
  await handleThread(client, channel, threadTs, ts, userId);
});

// --- cancel_run: "⛔ Cancel" button pressed during an active run ---
app.action("cancel_run", async ({ ack, payload }) => {
  await ack();
  const value = "value" in payload ? String(payload.value) : null;
  if (!value) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  const obj = toRecord(parsed);
  const threadTs = obj && isString(obj.threadTs) ? obj.threadTs : null;
  if (!threadTs) {
    return;
  }
  const run = activeRuns.get(threadTs);
  if (run) {
    run.cancelled = true;
    run.proc.kill("SIGTERM");
    console.log(`[spa] Cancelled run for thread ${threadTs}`);
  }
});

// #endregion

// #region Graceful shutdown

function shutdown(signal: string): void {
  console.log(`[spa] Received ${signal}, shutting down...`);
  for (const [threadTs, run] of activeRuns) {
    console.log(`[spa] Killing active run for thread ${threadTs}`);
    run.proc.kill("SIGTERM");
  }
  db.close();
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
  console.log(`[spa] Running (any channel + DMs, repo=${GITHUB_REPO})`);
})();

// #endregion
