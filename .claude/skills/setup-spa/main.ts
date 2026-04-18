// SPA (Spawn's Personal Agent) — Slack bot entry point.
// Pipes Slack threads into Claude Code sessions and streams responses back.

import type { ActionsBlock, ContextBlock, KnownBlock, SectionBlock } from "@slack/bolt";
import type { Block } from "@slack/types";
import type { ToolCall } from "./helpers";

import { timingSafeEqual } from "node:crypto";
import { isString, toRecord } from "@openrouter/spawn-shared";
import { App } from "@slack/bolt";
import * as v from "valibot";
import {
  downloadSlackFile,
  findCandidate,
  findThread,
  findTweet,
  formatToolStats,
  logDecision,
  logTweetDecision,
  markdownToRichTextBlocks,
  openDb,
  PR_URL_REGEX,
  parseStreamEvent,
  plainTextFallback,
  ResultSchema,
  readDecisions,
  runCleanupIfDue,
  stripMention,
  updateCandidateStatus,
  updateThread,
  updateTweetStatus,
  upsertCandidate,
  upsertThread,
  upsertTweet,
} from "./helpers";

type SlackClient = InstanceType<typeof App>["client"];

// #region Environment

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "OpenRouterTeam/spawn";
const TRIGGER_SECRET = process.env.TRIGGER_SECRET ?? "";
const GROWTH_TRIGGER_URL = process.env.GROWTH_TRIGGER_URL ?? "";
const GROWTH_REPLY_SECRET = process.env.GROWTH_REPLY_SECRET ?? "";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? "";
const HTTP_PORT = Number.parseInt(process.env.HTTP_PORT ?? "8080", 10);
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID ?? "";
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET ?? "";
const REDDIT_USERNAME = process.env.REDDIT_USERNAME ?? "";
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD ?? "";
const REDDIT_USER_AGENT = `spawn-growth:v1.0.0 (by /u/${REDDIT_USERNAME})`;

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

/**
 * Sanitize user input before writing to subprocess stdin.
 * Strips control characters (except tab, newline, carriage return) to prevent
 * escape-sequence injection. Enforces a 100KB size limit to prevent memory abuse.
 */
const MAX_STDIN_BYTES = 100 * 1024; // 100KB

function sanitizeStdinInput(input: string): string {
  // Strip non-printable control chars except \t (0x09), \n (0x0A), \r (0x0D)
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Enforce size limit (truncate to MAX_STDIN_BYTES in UTF-8)
  const encoded = new TextEncoder().encode(sanitized);
  if (encoded.byteLength > MAX_STDIN_BYTES) {
    return new TextDecoder().decode(encoded.slice(0, MAX_STDIN_BYTES));
  }
  return sanitized;
}

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

  proc.stdin.write(sanitizeStdinInput(prompt));
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

// --- growth_approve: post draft reply to Reddit ---
app.action("growth_approve", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const postId = payload && isString(payload.value) ? payload.value : "";
  if (!postId) return;

  const userId = "user" in body && toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";
  const candidate = findCandidate(db, postId);
  if (!candidate) return;

  if (candidate.status !== "pending") {
    await client.chat
      .postMessage({
        channel: candidate.slackChannel ?? "",
        thread_ts: candidate.slackTs ?? undefined,
        text: `:warning: Already handled (${candidate.status}${candidate.actionedBy ? ` by <@${candidate.actionedBy}>` : ""})`,
      })
      .catch(() => {});
    return;
  }

  updateCandidateStatus(db, postId, {
    status: "approved",
    actionedBy: userId,
  });

  // POST to growth VM to send the Reddit reply
  if (!GROWTH_TRIGGER_URL) {
    await client.chat
      .postMessage({
        channel: candidate.slackChannel ?? "",
        thread_ts: candidate.slackTs ?? undefined,
        text: ":x: GROWTH_TRIGGER_URL not configured — cannot post to Reddit",
      })
      .catch(() => {});
    return;
  }

  try {
    const res = await fetch(`${GROWTH_TRIGGER_URL}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROWTH_REPLY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        postId: candidate.postId,
        replyText: candidate.draftReply,
      }),
    });

    const result = toRecord(await res.json().catch(() => null));
    if (res.ok && result && result.ok) {
      const commentUrl = isString(result.commentUrl) ? result.commentUrl : "";
      updateCandidateStatus(db, postId, {
        status: "posted",
        actionedBy: userId,
        postedReply: candidate.draftReply,
        redditCommentUrl: commentUrl,
      });
      logDecision(candidate, "approved");
      // Update the Slack message — replace buttons with confirmation
      if (candidate.slackChannel && candidate.slackTs) {
        await replaceButtonsWithStatus(
          client,
          candidate.slackChannel,
          candidate.slackTs,
          `:white_check_mark: Posted by <@${userId}>${commentUrl ? ` — <${commentUrl}|view comment>` : ""}`,
        );
      }
    } else {
      const errMsg = isString(result?.error) ? result.error : `HTTP ${res.status}`;
      updateCandidateStatus(db, postId, {
        status: "error",
        actionedBy: userId,
      });
      await client.chat
        .postMessage({
          channel: candidate.slackChannel ?? "",
          thread_ts: candidate.slackTs ?? undefined,
          text: `:x: Reddit reply failed: ${errMsg}`,
        })
        .catch(() => {});
    }
  } catch (err) {
    updateCandidateStatus(db, postId, {
      status: "error",
      actionedBy: userId,
    });
    await client.chat
      .postMessage({
        channel: candidate.slackChannel ?? "",
        thread_ts: candidate.slackTs ?? undefined,
        text: `:x: Reddit reply failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => {});
  }
});

// --- growth_edit: open modal with draft reply for editing ---
app.action("growth_edit", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const postId = payload && isString(payload.value) ? payload.value : "";
  if (!postId) return;

  const triggerId = "trigger_id" in body && isString(body.trigger_id) ? body.trigger_id : "";
  if (!triggerId) return;

  const candidate = findCandidate(db, postId);
  if (!candidate) return;

  if (candidate.status !== "pending") {
    return; // already handled
  }

  await client.views
    .open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "growth_edit_submit",
        private_metadata: postId,
        title: {
          type: "plain_text",
          text: "Edit Reply",
        },
        submit: {
          type: "plain_text",
          text: "Post to Reddit",
        },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*<${candidate.permalink.startsWith("http") ? candidate.permalink : `https://reddit.com${candidate.permalink}`}|${candidate.title}>*\nr/${candidate.subreddit}`,
            },
          },
          {
            type: "input",
            block_id: "reply_block",
            label: {
              type: "plain_text",
              text: "Reply text",
            },
            element: {
              type: "plain_text_input",
              action_id: "reply_text",
              multiline: true,
              initial_value: candidate.draftReply,
            },
          },
        ],
      },
    })
    .catch(() => {});
});

// --- growth_edit_submit: modal submitted with edited reply ---
app.view("growth_edit_submit", async ({ ack, view, body, client }) => {
  await ack();
  const postId = view.private_metadata;
  if (!postId) return;

  const candidate = findCandidate(db, postId);
  if (!candidate || candidate.status !== "pending") return;

  const replyBlock = toRecord(view.state?.values?.reply_block?.reply_text);
  const editedReply = replyBlock && isString(replyBlock.value) ? replyBlock.value : "";
  if (!editedReply) return;

  const userId = toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";

  updateCandidateStatus(db, postId, {
    status: "approved",
    actionedBy: userId,
  });

  if (!GROWTH_TRIGGER_URL) return;

  try {
    const res = await fetch(`${GROWTH_TRIGGER_URL}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROWTH_REPLY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        postId: candidate.postId,
        replyText: editedReply,
      }),
    });

    const result = toRecord(await res.json().catch(() => null));
    if (res.ok && result && result.ok) {
      const commentUrl = isString(result.commentUrl) ? result.commentUrl : "";
      updateCandidateStatus(db, postId, {
        status: "posted",
        actionedBy: userId,
        postedReply: editedReply,
        redditCommentUrl: commentUrl,
      });
      logDecision(candidate, "edited", editedReply);
      if (candidate.slackChannel && candidate.slackTs) {
        await replaceButtonsWithStatus(
          client,
          candidate.slackChannel,
          candidate.slackTs,
          `:white_check_mark: Posted (edited) by <@${userId}>${commentUrl ? ` — <${commentUrl}|view comment>` : ""}`,
        );
      }
    } else {
      updateCandidateStatus(db, postId, {
        status: "error",
        actionedBy: userId,
      });
      if (candidate.slackChannel && candidate.slackTs) {
        await client.chat
          .postMessage({
            channel: candidate.slackChannel,
            thread_ts: candidate.slackTs,
            text: `:x: Reddit reply failed: ${isString(result?.error) ? result.error : `HTTP ${res.status}`}`,
          })
          .catch(() => {});
      }
    }
  } catch {
    updateCandidateStatus(db, postId, {
      status: "error",
      actionedBy: userId,
    });
  }
});

// --- growth_skip: skip this candidate ---
app.action("growth_skip", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const postId = payload && isString(payload.value) ? payload.value : "";
  if (!postId) return;

  const userId = "user" in body && toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";
  const candidate = findCandidate(db, postId);
  if (!candidate || candidate.status !== "pending") return;

  updateCandidateStatus(db, postId, {
    status: "skipped",
    actionedBy: userId,
  });
  logDecision(candidate, "skipped");

  if (candidate.slackChannel && candidate.slackTs) {
    await replaceButtonsWithStatus(
      client,
      candidate.slackChannel,
      candidate.slackTs,
      `:no_entry_sign: Skipped by <@${userId}>`,
    );
  }
});

// --- tweet_approve: mark tweet as approved ---
app.action("tweet_approve", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const tweetId = payload && isString(payload.value) ? payload.value : "";
  if (!tweetId) return;

  const userId = "user" in body && toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";
  const tweet = findTweet(db, tweetId);
  if (!tweet || tweet.status !== "pending") return;

  updateTweetStatus(db, tweetId, {
    status: "approved",
    actionedBy: userId,
  });
  logTweetDecision(tweet, "approved");

  if (tweet.slackChannel && tweet.slackTs) {
    await replaceButtonsWithStatus(
      client,
      tweet.slackChannel,
      tweet.slackTs,
      `:white_check_mark: Tweet approved by <@${userId}> — ready to post on X`,
    );
  }
});

// --- tweet_edit: open modal with tweet text for editing ---
app.action("tweet_edit", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const tweetId = payload && isString(payload.value) ? payload.value : "";
  if (!tweetId) return;

  const triggerId = "trigger_id" in body && isString(body.trigger_id) ? body.trigger_id : "";
  if (!triggerId) return;

  const tweet = findTweet(db, tweetId);
  if (!tweet || tweet.status !== "pending") return;

  await client.views
    .open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "tweet_edit_submit",
        private_metadata: tweetId,
        title: {
          type: "plain_text",
          text: "Edit Tweet",
        },
        submit: {
          type: "plain_text",
          text: "Save",
        },
        blocks: [
          {
            type: "input",
            block_id: "tweet_block",
            label: {
              type: "plain_text",
              text: "Tweet text",
            },
            element: {
              type: "plain_text_input",
              action_id: "tweet_text",
              multiline: true,
              max_length: 280,
              initial_value: tweet.tweetText,
            },
          },
        ],
      },
    })
    .catch(() => {});
});

// --- tweet_edit_submit: modal submitted with edited tweet ---
app.view("tweet_edit_submit", async ({ ack, view, body, client }) => {
  await ack();
  const tweetId = view.private_metadata;
  if (!tweetId) return;

  const tweet = findTweet(db, tweetId);
  if (!tweet || tweet.status !== "pending") return;

  const tweetBlock = toRecord(view.state?.values?.tweet_block?.tweet_text);
  const editedText = tweetBlock && isString(tweetBlock.value) ? tweetBlock.value : "";
  if (!editedText || editedText.length > 280) return;

  const userId = toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";

  db.run("UPDATE tweets SET tweet_text = ? WHERE tweet_id = ?", [editedText, tweetId]);

  updateTweetStatus(db, tweetId, {
    status: "approved",
    actionedBy: userId,
    postedText: editedText,
  });
  logTweetDecision(tweet, "edited", editedText);

  if (tweet.slackChannel && tweet.slackTs) {
    await replaceButtonsWithStatus(
      client,
      tweet.slackChannel,
      tweet.slackTs,
      `:white_check_mark: Tweet edited & approved by <@${userId}> — ready to post on X`,
    );
  }
});

// --- tweet_skip: skip this tweet ---
app.action("tweet_skip", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const tweetId = payload && isString(payload.value) ? payload.value : "";
  if (!tweetId) return;

  const userId = "user" in body && toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";
  const tweet = findTweet(db, tweetId);
  if (!tweet || tweet.status !== "pending") return;

  updateTweetStatus(db, tweetId, {
    status: "skipped",
    actionedBy: userId,
  });
  logTweetDecision(tweet, "skipped");

  if (tweet.slackChannel && tweet.slackTs) {
    await replaceButtonsWithStatus(
      client,
      tweet.slackChannel,
      tweet.slackTs,
      `:no_entry_sign: Skipped by <@${userId}>`,
    );
  }
});

// --- xeng_approve: mark engagement reply as approved ---
app.action("xeng_approve", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const engageId = payload && isString(payload.value) ? payload.value : "";
  if (!engageId) return;

  const userId = "user" in body && toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";
  const tweet = findTweet(db, engageId);
  if (!tweet || tweet.status !== "pending") return;

  updateTweetStatus(db, engageId, {
    status: "approved",
    actionedBy: userId,
  });
  logTweetDecision(tweet, "approved");

  if (tweet.slackChannel && tweet.slackTs) {
    await replaceButtonsWithStatus(
      client,
      tweet.slackChannel,
      tweet.slackTs,
      `:white_check_mark: Reply approved by <@${userId}> — ready to post on X`,
    );
  }
});

// --- xeng_edit: open modal with reply text for editing ---
app.action("xeng_edit", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const engageId = payload && isString(payload.value) ? payload.value : "";
  if (!engageId) return;

  const triggerId = "trigger_id" in body && isString(body.trigger_id) ? body.trigger_id : "";
  if (!triggerId) return;

  const tweet = findTweet(db, engageId);
  if (!tweet || tweet.status !== "pending") return;

  await client.views
    .open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "xeng_edit_submit",
        private_metadata: engageId,
        title: {
          type: "plain_text",
          text: "Edit Reply",
        },
        submit: {
          type: "plain_text",
          text: "Save",
        },
        blocks: [
          {
            type: "input",
            block_id: "reply_block",
            label: {
              type: "plain_text",
              text: "Reply text",
            },
            element: {
              type: "plain_text_input",
              action_id: "reply_text",
              multiline: true,
              max_length: 280,
              initial_value: tweet.tweetText,
            },
          },
        ],
      },
    })
    .catch(() => {});
});

// --- xeng_edit_submit: modal submitted with edited reply ---
app.view("xeng_edit_submit", async ({ ack, view, body, client }) => {
  await ack();
  const engageId = view.private_metadata;
  if (!engageId) return;

  const tweet = findTweet(db, engageId);
  if (!tweet || tweet.status !== "pending") return;

  const replyBlock = toRecord(view.state?.values?.reply_block?.reply_text);
  const editedText = replyBlock && isString(replyBlock.value) ? replyBlock.value : "";
  if (!editedText || editedText.length > 280) return;

  const userId = toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";

  db.run("UPDATE tweets SET tweet_text = ? WHERE tweet_id = ?", [editedText, engageId]);

  updateTweetStatus(db, engageId, {
    status: "approved",
    actionedBy: userId,
    postedText: editedText,
  });
  logTweetDecision(tweet, "edited", editedText);

  if (tweet.slackChannel && tweet.slackTs) {
    await replaceButtonsWithStatus(
      client,
      tweet.slackChannel,
      tweet.slackTs,
      `:white_check_mark: Reply edited & approved by <@${userId}> — ready to post on X`,
    );
  }
});

// --- xeng_skip: skip this engagement opportunity ---
app.action("xeng_skip", async ({ ack, body, client }) => {
  await ack();
  const payload = toRecord("actions" in body && Array.isArray(body.actions) ? body.actions[0] : null);
  const engageId = payload && isString(payload.value) ? payload.value : "";
  if (!engageId) return;

  const userId = "user" in body && toRecord(body.user) ? String((toRecord(body.user) ?? {}).id ?? "") : "";
  const tweet = findTweet(db, engageId);
  if (!tweet || tweet.status !== "pending") return;

  updateTweetStatus(db, engageId, {
    status: "skipped",
    actionedBy: userId,
  });
  logTweetDecision(tweet, "skipped");

  if (tweet.slackChannel && tweet.slackTs) {
    await replaceButtonsWithStatus(
      client,
      tweet.slackChannel,
      tweet.slackTs,
      `:no_entry_sign: Skipped by <@${userId}>`,
    );
  }
});

/** Replace the actions block in a candidate card with a status context line. */
async function replaceButtonsWithStatus(
  client: SlackClient,
  channel: string,
  ts: string,
  statusText: string,
): Promise<void> {
  try {
    // Fetch the current message to get its blocks
    const result = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const msg = result.messages?.[0];
    if (!msg) return;

    const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
    // Replace the actions block with a context block showing the status
    const updatedBlocks = blocks
      .filter((b: Record<string, unknown>) => b.type !== "actions")
      .concat({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: statusText,
          },
        ],
      });

    await client.chat.update({
      channel,
      ts,
      text: statusText,
      blocks: updatedBlocks,
    });
  } catch {
    // non-fatal
  }
}

// #endregion

// #region Growth candidate HTTP server

/** Valibot schema for incoming candidate JSON from growth agent. */
const CandidatePayloadSchema = v.object({
  found: v.boolean(),
  title: v.optional(v.string()),
  url: v.optional(v.string()),
  permalink: v.optional(v.string()),
  subreddit: v.optional(v.string()),
  postId: v.optional(v.string()),
  upvotes: v.optional(v.number()),
  numComments: v.optional(v.number()),
  postedAgo: v.optional(v.string()),
  whatTheyAsked: v.optional(v.string()),
  whySpawnFits: v.optional(v.string()),
  posterQualification: v.optional(v.string()),
  relevanceScore: v.optional(v.number()),
  draftReply: v.optional(v.string()),
  postsScanned: v.optional(v.number()),
});

const TweetPayloadSchema = v.object({
  found: v.boolean(),
  type: v.literal("tweet"),
  tweetText: v.optional(v.string()),
  topic: v.optional(v.string()),
  category: v.optional(v.string()),
  sourceCommits: v.optional(v.array(v.string())),
  charCount: v.optional(v.number()),
  reason: v.optional(v.string()),
});

const XEngagePayloadSchema = v.object({
  found: v.boolean(),
  type: v.literal("x_engage"),
  replyText: v.optional(v.string()),
  sourceTweetId: v.optional(v.string()),
  sourceTweetUrl: v.optional(v.string()),
  sourceTweetText: v.optional(v.string()),
  sourceAuthor: v.optional(v.string()),
  whyEngage: v.optional(v.string()),
  relevanceScore: v.optional(v.number()),
  charCount: v.optional(v.number()),
  reason: v.optional(v.string()),
});

/** Timing-safe auth for the HTTP trigger endpoint. */
function isHttpAuthed(req: Request): boolean {
  if (!TRIGGER_SECRET) return false;
  const given = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${TRIGGER_SECRET}`;
  // Use try/catch instead of length pre-check: timingSafeEqual throws on length
  // mismatch, and the pre-check leaks the expected secret length via timing (CWE-208).
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Post a Block Kit candidate card to Slack and store in DB. */
async function postCandidateCard(
  client: SlackClient,
  candidate: v.InferOutput<typeof CandidatePayloadSchema>,
): Promise<Response> {
  const channel = SLACK_CHANNEL_ID;
  if (!channel) {
    return Response.json(
      {
        error: "SLACK_CHANNEL_ID not configured",
      },
      {
        status: 500,
      },
    );
  }

  if (!candidate.found) {
    // No candidate — post brief summary
    const scanText = candidate.postsScanned
      ? `Growth scan complete — scanned ${candidate.postsScanned} posts, no candidates today.`
      : "Growth scan complete — no candidates today.";
    await client.chat
      .postMessage({
        channel,
        text: scanText,
        blocks: [
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: scanText,
              },
            ],
          },
        ],
      })
      .catch(() => {});
    return Response.json({
      ok: true,
      action: "no_candidate",
    });
  }

  // Candidate found — build Block Kit card
  const title = candidate.title ?? "Untitled";
  const url = candidate.url ?? `https://reddit.com${candidate.permalink ?? ""}`;
  const postId = candidate.postId ?? "";
  const subreddit = candidate.subreddit ?? "";
  const upvotes = candidate.upvotes ?? 0;
  const numComments = candidate.numComments ?? 0;
  const postedAgo = candidate.postedAgo ?? "";
  const draftReply = candidate.draftReply ?? "";

  const blocks: (KnownBlock | Block)[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Reddit Growth — Candidate Found",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${url}|${title}>*\nr/${subreddit} | ${upvotes} upvotes | ${numComments} comments | ${postedAgo}`,
      },
    },
  ];

  if (candidate.whatTheyAsked) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*What they asked:*\n${candidate.whatTheyAsked}`,
      },
    });
  }

  if (candidate.whySpawnFits) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Why Spawn fits:*\n${candidate.whySpawnFits}`,
      },
    });
  }

  if (candidate.posterQualification) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Poster signals:*\n${candidate.posterQualification}`,
      },
    });
  }

  if (draftReply) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Draft reply:*\n>${draftReply.replace(/\n/g, "\n>")}`,
      },
    });
  }

  if (candidate.relevanceScore !== undefined) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Relevance: ${candidate.relevanceScore}/10`,
        },
      ],
    });
  }

  // Action buttons
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Approve",
          emoji: true,
        },
        style: "primary",
        action_id: "growth_approve",
        value: postId,
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Edit",
          emoji: true,
        },
        action_id: "growth_edit",
        value: postId,
      },
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Skip",
          emoji: true,
        },
        style: "danger",
        action_id: "growth_skip",
        value: postId,
      },
    ],
  });

  const msg = await client.chat.postMessage({
    channel,
    text: `Reddit Growth — ${title}`,
    blocks,
  });

  // Store candidate in DB
  upsertCandidate(db, {
    postId,
    permalink: candidate.permalink ?? "",
    title,
    subreddit,
    draftReply,
    slackChannel: channel,
    slackTs: msg.ts ?? undefined,
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  return Response.json({
    ok: true,
    action: "posted",
    ts: msg.ts,
  });
}

/** Post a tweet draft card to Slack for approval. */
async function postTweetCard(
  client: SlackClient,
  payload: typeof TweetPayloadSchema._types.output,
): Promise<Response> {
  const db = openDb();

  if (!payload.found) {
    const text = payload.reason ?? "No tweet-worthy content this cycle.";
    await client.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text,
    });
    return Response.json({ ok: true, action: "no_tweet" });
  }

  const tweetText = payload.tweetText ?? "";
  const topic = payload.topic ?? "Spawn update";
  const category = payload.category ?? "feature";
  const commits = payload.sourceCommits ?? [];
  const charCount = payload.charCount ?? tweetText.length;
  const now = new Date();
  const tweetId = `tweet_${now.toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;

  const commitLinks = commits
    .slice(0, 5)
    .map((h) => `<https://github.com/${GITHUB_REPO}/commit/${h}|${h.slice(0, 7)}>`)
    .join(", ");

  const categoryIcon =
    category === "fix" ? ":wrench:" : category === "best-practice" ? ":bulb:" : ":rocket:";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🐦 Tweet Draft — " + category, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `>${tweetText.replace(/\n/g, "\n>")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${categoryIcon} *${category}* | ${charCount}/280 chars${commitLinks ? ` | Commits: ${commitLinks}` : ""}`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Topic:* ${topic}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: "tweet_approve",
          value: tweetId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Edit", emoji: true },
          action_id: "tweet_edit",
          value: tweetId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip", emoji: true },
          style: "danger",
          action_id: "tweet_skip",
          value: tweetId,
        },
      ],
    },
  ];

  const msg = await client.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: `🐦 Tweet draft: ${topic}`,
    blocks,
  });

  upsertTweet(db, {
    tweetId,
    tweetText,
    topic,
    category,
    sourceCommits: commits.length > 0 ? JSON.stringify(commits) : undefined,
    slackChannel: SLACK_CHANNEL_ID,
    slackTs: msg.ts ?? undefined,
    status: "pending",
    createdAt: now.toISOString(),
  });

  return Response.json({ ok: true, action: "posted", tweetId });
}

/** Post an X engagement opportunity card to Slack for approval. */
async function postXEngageCard(
  client: SlackClient,
  payload: typeof XEngagePayloadSchema._types.output,
): Promise<Response> {
  const db = openDb();

  if (!payload.found) {
    const text = payload.reason ?? "No engagement opportunities this cycle.";
    await client.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text,
    });
    return Response.json({ ok: true, action: "no_engage" });
  }

  const replyText = payload.replyText ?? "";
  const sourceUrl = payload.sourceTweetUrl ?? "";
  const sourceText = payload.sourceTweetText ?? "";
  const sourceAuthor = payload.sourceAuthor ?? "unknown";
  const whyEngage = payload.whyEngage ?? "";
  const relevance = payload.relevanceScore ?? 0;
  const charCount = payload.charCount ?? replyText.length;
  const now = new Date();
  const engageId = `xeng_${now.toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔍 X Mention — Engagement Opportunity", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*<${sourceUrl}|@${sourceAuthor}>:*\n>${sourceText.slice(0, 500).replace(/\n/g, "\n>")}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Why engage:* ${whyEngage}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Draft reply:*\n>${replyText.replace(/\n/g, "\n>")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Relevance: ${relevance}/10 | ${charCount}/280 chars`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: "xeng_approve",
          value: engageId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Edit", emoji: true },
          action_id: "xeng_edit",
          value: engageId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Skip", emoji: true },
          style: "danger",
          action_id: "xeng_skip",
          value: engageId,
        },
      ],
    },
  ];

  const msg = await client.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: `🔍 X engagement: @${sourceAuthor}`,
    blocks,
  });

  upsertTweet(db, {
    tweetId: engageId,
    tweetText: replyText,
    topic: `Reply to @${sourceAuthor}`,
    category: "engage",
    sourceTweetId: payload.sourceTweetId ?? undefined,
    replyToUrl: sourceUrl || undefined,
    slackChannel: SLACK_CHANNEL_ID,
    slackTs: msg.ts ?? undefined,
    status: "pending",
    createdAt: now.toISOString(),
  });

  return Response.json({ ok: true, action: "posted", engageId });
}

/** Get a Reddit OAuth access token. */
async function getRedditToken(): Promise<string | null> {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !REDDIT_USERNAME || !REDDIT_PASSWORD) {
    return null;
  }
  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: `grant_type=password&username=${encodeURIComponent(REDDIT_USERNAME)}&password=${encodeURIComponent(REDDIT_PASSWORD)}`,
  });
  const json: unknown = await res.json();
  const parsed = v.safeParse(v.object({ access_token: v.string() }), json);
  return parsed.success ? parsed.output.access_token : null;
}

/** Post a reply to a Reddit thread. Returns the comment URL or an error. */
async function postRedditReply(postId: string, replyText: string): Promise<Response> {
  const token = await getRedditToken();
  if (!token) {
    return Response.json(
      {
        error: "Reddit credentials not configured",
      },
      {
        status: 500,
      },
    );
  }

  // Reddit's "comment" endpoint takes the parent fullname (t3_xxx for posts, t1_xxx for comments)
  const res = await fetch("https://oauth.reddit.com/api/comment", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: `thing_id=${encodeURIComponent(postId)}&text=${encodeURIComponent(replyText)}`,
  });

  const json: unknown = await res.json();

  if (!res.ok) {
    const errParsed = v.safeParse(v.object({ message: v.string() }), json);
    const errMsg = errParsed.success ? errParsed.output.message : `HTTP ${res.status}`;
    console.error(`[spa] Reddit reply failed: ${errMsg}`);
    return Response.json(
      {
        ok: false,
        error: errMsg,
      },
      {
        status: 502,
      },
    );
  }

  // Reddit's legacy "comment" endpoint returns a jQuery-style response.
  // Extract the permalink from nested arrays: jquery[n][3][m].data.permalink
  const JqueryCommentSchema = v.object({
    jquery: v.array(v.unknown()),
  });
  const JqueryInnerSchema = v.object({
    data: v.object({ permalink: v.string() }),
  });

  let commentUrl = "";
  const jqParsed = v.safeParse(JqueryCommentSchema, json);
  if (jqParsed.success) {
    for (const item of jqParsed.output.jquery) {
      if (Array.isArray(item) && item.length >= 4 && Array.isArray(item[3])) {
        for (const inner of item[3]) {
          const innerParsed = v.safeParse(JqueryInnerSchema, inner);
          if (innerParsed.success) {
            commentUrl = `https://reddit.com${innerParsed.output.data.permalink}`;
          }
        }
      }
    }
  }

  console.log(`[spa] Reddit reply posted: ${commentUrl || postId}`);
  return Response.json({
    ok: true,
    commentUrl,
  });
}

/** Simple token-bucket rate limiter: max 10 requests per minute per endpoint. */
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(endpoint: string): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(endpoint) ?? { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }
  bucket.count = bucket.count + 1;
  rateLimitBuckets.set(endpoint, bucket);
  return bucket.count <= 10;
}

/** Start the HTTP server for growth candidate ingestion. */
function startHttpServer(client: SlackClient): void {
  if (!TRIGGER_SECRET) {
    console.log("[spa] TRIGGER_SECRET not set — HTTP server disabled");
    return;
  }

  Bun.serve({
    port: HTTP_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        if (!checkRateLimit("/health")) {
          return Response.json({ error: "rate limit exceeded" }, { status: 429 });
        }
        return Response.json({
          status: "ok",
        });
      }

      if (req.method === "POST" && url.pathname === "/candidate") {
        if (!isHttpAuthed(req)) {
          return Response.json(
            {
              error: "unauthorized",
            },
            {
              status: 401,
            },
          );
        }
        if (!checkRateLimit("/candidate")) {
          return Response.json({ error: "rate limit exceeded" }, { status: 429 });
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            {
              error: "invalid JSON",
            },
            {
              status: 400,
            },
          );
        }

        const bodyObj = toRecord(body);
        if (bodyObj && bodyObj.type === "tweet") {
          const parsed = v.safeParse(TweetPayloadSchema, body);
          if (!parsed.success) {
            return Response.json({ error: "invalid tweet payload" }, { status: 400 });
          }
          return postTweetCard(client, parsed.output);
        }
        if (bodyObj && bodyObj.type === "x_engage") {
          const parsed = v.safeParse(XEngagePayloadSchema, body);
          if (!parsed.success) {
            return Response.json({ error: "invalid engage payload" }, { status: 400 });
          }
          return postXEngageCard(client, parsed.output);
        }

        const parsed = v.safeParse(CandidatePayloadSchema, body);
        if (!parsed.success) {
          return Response.json(
            {
              error: "invalid payload",
              issues: parsed.issues,
            },
            {
              status: 400,
            },
          );
        }

        return postCandidateCard(client, parsed.output);
      }

      if (req.method === "POST" && url.pathname === "/reply") {
        if (!isHttpAuthed(req)) {
          return Response.json(
            {
              error: "unauthorized",
            },
            {
              status: 401,
            },
          );
        }
        if (!checkRateLimit("/reply")) {
          return Response.json({ error: "rate limit exceeded" }, { status: 429 });
        }

        const replySchema = v.object({
          postId: v.string(),
          replyText: v.string(),
        });

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            {
              error: "invalid JSON",
            },
            {
              status: 400,
            },
          );
        }

        const parsed = v.safeParse(replySchema, body);
        if (!parsed.success) {
          return Response.json(
            {
              error: "invalid payload",
            },
            {
              status: 400,
            },
          );
        }

        return postRedditReply(parsed.output.postId, parsed.output.replyText);
      }

      return Response.json(
        {
          error: "not found",
        },
        {
          status: 404,
        },
      );
    },
  });

  console.log(`[spa] HTTP server listening on port ${HTTP_PORT}`);
}

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
  startHttpServer(app.client);
  console.log(`[spa] Running (any channel + DMs, repo=${GITHUB_REPO})`);
})();

// #endregion
