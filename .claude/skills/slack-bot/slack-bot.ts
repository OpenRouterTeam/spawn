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
// State — thread-to-issue mappings persisted to disk
// ---------------------------------------------------------------------------

const STATE_PATH =
  process.env.STATE_PATH ??
  `${process.env.HOME ?? "/root"}/.config/spawn/slack-issues.json`;

const MappingSchema = v.object({
  channel: v.string(),
  threadTs: v.string(),
  issueNumber: v.number(),
  issueUrl: v.string(),
  repo: v.string(),
  createdAt: v.string(),
});

const StateSchema = v.object({
  mappings: v.array(MappingSchema),
});

type Mapping = v.InferOutput<typeof MappingSchema>;
type State = v.InferOutput<typeof StateSchema>;

function loadState(): State {
  try {
    if (!existsSync(STATE_PATH)) return { mappings: [] };
    const raw = readFileSync(STATE_PATH, "utf-8");
    const parsed = v.parse(StateSchema, JSON.parse(raw));
    return parsed;
  } catch {
    console.warn("[slack-bot] Could not load state, starting fresh");
    return { mappings: [] };
  }
}

function saveState(state: State): void {
  const dir = dirname(STATE_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function findMapping(
  state: State,
  channel: string,
  threadTs: string,
): Mapping | undefined {
  return state.mappings.find(
    (m) => m.channel === channel && m.threadTs === threadTs,
  );
}

function addMapping(state: State, mapping: Mapping): void {
  state.mappings.push(mapping);
  saveState(state);
}

const state = loadState();

// ---------------------------------------------------------------------------
// GitHub helpers — uses `gh` CLI (assumes `gh auth login` is done)
// ---------------------------------------------------------------------------

const GhIssueSchema = v.object({
  number: v.number(),
  url: v.string(),
});

async function ghExec(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function createGitHubIssue(
  title: string,
  body: string,
): Promise<{ number: number; url: string } | null> {
  const result = await ghExec([
    "issue",
    "create",
    "--repo",
    GITHUB_REPO,
    "--title",
    title,
    "--body",
    body,
    "--json",
    "number,url",
  ]);
  if (!result.ok) {
    console.error(`[slack-bot] gh issue create failed: ${result.stderr}`);
    return null;
  }
  const parsed = v.safeParse(GhIssueSchema, JSON.parse(result.stdout));
  if (!parsed.success) {
    console.error("[slack-bot] Unexpected gh output shape");
    return null;
  }
  return { number: parsed.output.number, url: parsed.output.url };
}

async function addGitHubComment(
  issueNumber: number,
  body: string,
): Promise<boolean> {
  const result = await ghExec([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    GITHUB_REPO,
    "--body",
    body,
  ]);
  if (!result.ok) {
    console.error(`[slack-bot] gh issue comment failed: ${result.stderr}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function parseIssueText(text: string): { title: string; body: string } {
  const cleaned = stripMention(text);
  const lines = cleaned.split("\n");
  const firstLine = (lines[0] ?? "").trim();
  const title =
    firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
  const rest = lines.slice(1).join("\n").trim();
  return { title, body: rest };
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

// --- app_mention: create issue or add comment if thread already tracked ---
app.event("app_mention", async ({ event, client }) => {
  if (event.channel !== SLACK_CHANNEL_ID) return;

  const threadTs = event.thread_ts ?? event.ts;
  const existing = findMapping(state, event.channel, threadTs);

  if (existing) {
    // Thread already mapped — add as comment
    const text = stripMention(event.text ?? "");
    const userName = event.user ? `<@${event.user}>` : "Someone";
    const commentBody = `**${userName}** mentioned the bot in [Slack thread](https://slack.com/archives/${event.channel}/p${threadTs.replace(".", "")}):\n\n${text}`;

    const ok = await addGitHubComment(existing.issueNumber, commentBody);
    if (ok) {
      await client.reactions
        .add({
          channel: event.channel,
          timestamp: event.ts,
          name: "speech_balloon",
        })
        .catch(() => {});
    }
    return;
  }

  // New issue
  const { title, body } = parseIssueText(event.text ?? "");
  if (!title) {
    await client.chat
      .postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "Please include a description for the issue after mentioning me.",
      })
      .catch(() => {});
    return;
  }

  const userName = event.user ? `<@${event.user}>` : "Someone";
  const slackLink = `https://slack.com/archives/${event.channel}/p${threadTs.replace(".", "")}`;
  const fullBody = [
    body,
    "",
    "---",
    `_Filed from Slack by ${userName} ([thread](${slackLink}))_`,
  ].join("\n");

  const issue = await createGitHubIssue(title, fullBody);
  if (!issue) {
    await client.chat
      .postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "Failed to create GitHub issue. Check bot logs.",
      })
      .catch(() => {});
    return;
  }

  addMapping(state, {
    channel: event.channel,
    threadTs,
    issueNumber: issue.number,
    issueUrl: issue.url,
    repo: GITHUB_REPO,
    createdAt: new Date().toISOString(),
  });

  await client.reactions
    .add({
      channel: event.channel,
      timestamp: event.ts,
      name: "white_check_mark",
    })
    .catch(() => {});

  await client.chat
    .postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `Created issue: <${issue.url}|#${issue.number} — ${title}>`,
    })
    .catch(() => {});

  console.log(
    `[slack-bot] Created issue #${issue.number} from thread ${threadTs}`,
  );
});

// --- message: sync thread replies as comments ---
app.event("message", async ({ event, client }) => {
  // Type narrowing for message events
  if (!("channel" in event) || event.channel !== SLACK_CHANNEL_ID) return;

  // Only thread replies
  const threadTs =
    "thread_ts" in event && typeof event.thread_ts === "string"
      ? event.thread_ts
      : undefined;
  if (!threadTs) return;

  // Ignore bot messages
  if ("bot_id" in event && event.bot_id) return;
  if ("subtype" in event && event.subtype === "bot_message") return;

  const mapping = findMapping(state, event.channel, threadTs);
  if (!mapping) return;

  const text =
    "text" in event && typeof event.text === "string" ? event.text : "";
  const userId =
    "user" in event && typeof event.user === "string" ? event.user : "Someone";
  const userName = `<@${userId}>`;
  const ts = "ts" in event && typeof event.ts === "string" ? event.ts : "";

  const commentBody = `**${userName}** commented in [Slack thread](https://slack.com/archives/${event.channel}/p${threadTs.replace(".", "")}):\n\n${text}`;

  const ok = await addGitHubComment(mapping.issueNumber, commentBody);
  if (ok && ts) {
    await client.reactions
      .add({ channel: event.channel, timestamp: ts, name: "speech_balloon" })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`[slack-bot] Received ${signal}, shutting down...`);
  saveState(state);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  await app.start();
  console.log(
    `[slack-bot] Running (channel=${SLACK_CHANNEL_ID}, repo=${GITHUB_REPO})`,
  );
})();
