#!/bin/bash
set -eo pipefail

# Growth Agent — Single Cycle
# Phase 0a: Draft daily tweet about Spawn features from git history
# Phase 0b: Search X for Spawn mentions + draft engagement replies (if X creds set)
# Phase 1: Batch-fetch Reddit posts via reddit-fetch.ts (fast, parallel)
# Phase 2: Pass results to Claude for scoring/qualification (no tool use)
# Phase 3: POST candidate to SPA for Slack notification

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

SPAWN_REASON="${SPAWN_REASON:-manual}"
TEAM_NAME="spawn-growth"
HARD_TIMEOUT=600   # 10 min (claude scoring can take 5+ min with large post sets)

LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""
REDDIT_DATA_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] [growth] $*" | tee -a "${LOG_FILE}"
}

# Cleanup function
cleanup() {
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1

    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."

    rm -f "${PROMPT_FILE:-}" "${REDDIT_DATA_FILE:-}" "${CLAUDE_STREAM_FILE:-}" \
          "${CLAUDE_OUTPUT_FILE:-}" "${SPA_AUTH_FILE:-}" "${SPA_BODY_FILE:-}" \
          "${GIT_DATA_FILE:-}" "${TWEET_PROMPT_FILE:-}" "${TWEET_STREAM_FILE:-}" \
          "${TWEET_OUTPUT_FILE:-}" "${X_DATA_FILE:-}" "${XENG_PROMPT_FILE:-}" \
          "${XENG_STREAM_FILE:-}" "${XENG_OUTPUT_FILE:-}" 2>/dev/null || true
    if [[ -n "${CLAUDE_PID:-}" ]] && kill -0 "${CLAUDE_PID}" 2>/dev/null; then
        kill -TERM "${CLAUDE_PID}" 2>/dev/null || true
    fi
    if [[ -n "${TWEET_CLAUDE_PID:-}" ]] && kill -0 "${TWEET_CLAUDE_PID}" 2>/dev/null; then
        kill -TERM "${TWEET_CLAUDE_PID}" 2>/dev/null || true
    fi
    if [[ -n "${XENG_CLAUDE_PID:-}" ]] && kill -0 "${XENG_CLAUDE_PID}" 2>/dev/null; then
        kill -TERM "${XENG_CLAUDE_PID}" 2>/dev/null || true
    fi

    log "=== Cycle Done (exit_code=${exit_code}) ==="
    exit ${exit_code}
}

trap cleanup EXIT SIGTERM SIGINT

log "=== Starting growth cycle ==="
log "Working directory: ${REPO_ROOT}"
log "Reason: ${SPAWN_REASON}"

# Fetch latest refs
log "Fetching latest refs..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

# --- Phase 0a: Draft daily tweet from git history ---
log "Phase 0a: Drafting tweet from recent git activity..."

GIT_DATA_FILE=$(mktemp /tmp/growth-git-XXXXXX.json)
chmod 0600 "${GIT_DATA_FILE}"
TWEET_PROMPT_FILE=$(mktemp /tmp/growth-tweet-prompt-XXXXXX.md)
chmod 0600 "${TWEET_PROMPT_FILE}"
TWEET_STREAM_FILE=$(mktemp /tmp/growth-tweet-stream-XXXXXX.jsonl)
TWEET_OUTPUT_FILE=$(mktemp /tmp/growth-tweet-output-XXXXXX.txt)
TWEET_TEMPLATE="${SCRIPT_DIR}/tweet-prompt.md"
TWEET_DECISIONS_FILE="${HOME}/.config/spawn/tweet-decisions.md"

# Gather git data from last 7 days
_OUT="${GIT_DATA_FILE}" bun -e '
const { execSync } = require("child_process");
const raw = execSync("git log --since=\"7 days ago\" --format=\"%H|%s|%an|%ad\" --date=short", { encoding: "utf-8" });
const commits = raw.trim().split("\n").filter(Boolean).map((line) => {
  const [hash, subject, author, date] = line.split("|");
  const prefix = (subject ?? "").match(/^(feat|fix|refactor|docs|test|chore|perf|ci)/)?.[1] ?? "other";
  return { hash: (hash ?? "").slice(0, 12), subject: subject ?? "", author: author ?? "", date: date ?? "", category: prefix };
});
await Bun.write(process.env._OUT, JSON.stringify({ commits, count: commits.length }, null, 2));
' 2>> "${LOG_FILE}" || true

COMMIT_COUNT=$(_DATA_FILE="${GIT_DATA_FILE}" bun -e 'const d=JSON.parse(await Bun.file(process.env._DATA_FILE).text()); console.log(d.count ?? 0)' 2>/dev/null) || COMMIT_COUNT="0"
log "Phase 0a: ${COMMIT_COUNT} commits in last 7 days"

if [[ -f "${TWEET_TEMPLATE}" && "${COMMIT_COUNT}" -gt 0 ]]; then
    # Assemble tweet prompt
    _TEMPLATE="${TWEET_TEMPLATE}"     _DATA_FILE="${GIT_DATA_FILE}"     _DECISIONS="${TWEET_DECISIONS_FILE}"     _OUT="${TWEET_PROMPT_FILE}"     bun -e '
    import { existsSync } from "node:fs";
    const template = await Bun.file(process.env._TEMPLATE).text();
    const data = await Bun.file(process.env._DATA_FILE).text();
    const decisionsPath = process.env._DECISIONS;
    const decisions = existsSync(decisionsPath) ? await Bun.file(decisionsPath).text() : "No past tweet decisions yet.";
    const result = template
      .replace("GIT_DATA_PLACEHOLDER", data.trim())
      .replace("TWEET_DECISIONS_PLACEHOLDER", decisions.trim());
    await Bun.write(process.env._OUT, result);
    ' 2>> "${LOG_FILE}" || true

    # Run Claude for tweet (120s timeout — tweets are simpler)
    TWEET_TIMEOUT=120
    log "Phase 0a: Running Claude for tweet draft (timeout=${TWEET_TIMEOUT}s)..."
    setsid claude -p - --model sonnet --output-format stream-json --verbose         < "${TWEET_PROMPT_FILE}" > "${TWEET_STREAM_FILE}" 2>> "${LOG_FILE}" &
    TWEET_CLAUDE_PID=$!
    TWEET_WALL_START=$(date +%s)

    while kill -0 "${TWEET_CLAUDE_PID}" 2>/dev/null; do
        sleep 5
        TWEET_ELAPSED=$(( $(date +%s) - TWEET_WALL_START ))
        if [[ "${TWEET_ELAPSED}" -ge "${TWEET_TIMEOUT}" ]]; then
            log "Phase 0a: timeout (${TWEET_ELAPSED}s) — killing"
            kill -TERM -"${TWEET_CLAUDE_PID}" 2>/dev/null || true
            sleep 2
            kill -KILL -"${TWEET_CLAUDE_PID}" 2>/dev/null || true
            break
        fi
    done
    wait "${TWEET_CLAUDE_PID}" 2>/dev/null || true

    # Extract text from stream
    _STREAM="${TWEET_STREAM_FILE}"     _OUT="${TWEET_OUTPUT_FILE}"     bun -e '
    const lines = (await Bun.file(process.env._STREAM).text()).split("\n").filter(Boolean);
    const texts = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === "text" && block.text) texts.push(block.text);
          }
        }
      } catch {}
    }
    await Bun.write(process.env._OUT, texts.join("\n"));
    ' 2>> "${LOG_FILE}" || true

    # Extract json:tweet
    TWEET_JSON=""
    if [[ -f "${TWEET_OUTPUT_FILE}" ]]; then
        TWEET_JSON=$(_OUT="${TWEET_OUTPUT_FILE}" bun -e '
        const text = await Bun.file(process.env._OUT).text();
        const blocks = [...text.matchAll(/```json:tweet\n([\s\S]*?)\n```/g)];
        let result = "";
        for (const block of blocks) {
          try { result = JSON.stringify(JSON.parse(block[1].trim())); } catch {}
        }
        if (result) console.log(result);
        ' 2>/dev/null) || true
    fi

    if [[ -n "${TWEET_JSON}" ]]; then
        log "Phase 0a: Tweet JSON: ${TWEET_JSON}"
        # POST to SPA
        if [[ -n "${SPA_TRIGGER_URL:-}" && -n "${SPA_TRIGGER_SECRET:-}" ]]; then
            TWEET_AUTH_FILE=$(mktemp /tmp/growth-tweet-auth-XXXXXX.conf)
            TWEET_BODY_FILE=$(mktemp /tmp/growth-tweet-body-XXXXXX.json)
            chmod 0600 "${TWEET_AUTH_FILE}" "${TWEET_BODY_FILE}"
            printf 'header = "Authorization: Bearer %s"\n' "${SPA_TRIGGER_SECRET}" > "${TWEET_AUTH_FILE}"
            printf '%s' "${TWEET_JSON}" > "${TWEET_BODY_FILE}"
            TWEET_HTTP=$(curl -s -o /dev/null -w "%{http_code}"                 -X POST "${SPA_TRIGGER_URL}/candidate"                 -K "${TWEET_AUTH_FILE}"                 -H "Content-Type: application/json"                 --data-binary @"${TWEET_BODY_FILE}"                 --max-time 30) || TWEET_HTTP="000"
            rm -f "${TWEET_AUTH_FILE}" "${TWEET_BODY_FILE}"
            log "Phase 0a: SPA response: HTTP ${TWEET_HTTP}"
        fi
    else
        log "Phase 0a: No json:tweet block found"
    fi
else
    log "Phase 0a: Skipping (no template or no commits)"
fi

# --- Phase 0b: Search X for mentions + draft engagement ---
if [[ -z "${X_API_KEY:-}" ]]; then
    log "Phase 0b: Skipping (no X API credentials)"
else
    log "Phase 0b: Searching X for Spawn mentions..."

    X_DATA_FILE=$(mktemp /tmp/growth-x-XXXXXX.json)
    chmod 0600 "${X_DATA_FILE}"
    XENG_PROMPT_FILE=$(mktemp /tmp/growth-xeng-prompt-XXXXXX.md)
    chmod 0600 "${XENG_PROMPT_FILE}"
    XENG_STREAM_FILE=$(mktemp /tmp/growth-xeng-stream-XXXXXX.jsonl)
    XENG_OUTPUT_FILE=$(mktemp /tmp/growth-xeng-output-XXXXXX.txt)
    XENG_TEMPLATE="${SCRIPT_DIR}/x-engage-prompt.md"

    if bun run "${SCRIPT_DIR}/x-fetch.ts" > "${X_DATA_FILE}" 2>> "${LOG_FILE}"; then
        X_POST_COUNT=$(_DATA_FILE="${X_DATA_FILE}" bun -e 'const d=JSON.parse(await Bun.file(process.env._DATA_FILE).text()); console.log(d.postsScanned ?? d.posts?.length ?? 0)' 2>/dev/null) || X_POST_COUNT="0"
        log "Phase 0b: ${X_POST_COUNT} tweets fetched"

        if [[ -f "${XENG_TEMPLATE}" && "${X_POST_COUNT}" -gt 0 ]]; then
            # Assemble engage prompt
            _TEMPLATE="${XENG_TEMPLATE}"             _DATA_FILE="${X_DATA_FILE}"             _DECISIONS="${TWEET_DECISIONS_FILE}"             _OUT="${XENG_PROMPT_FILE}"             bun -e '
            import { existsSync } from "node:fs";
            const template = await Bun.file(process.env._TEMPLATE).text();
            const data = await Bun.file(process.env._DATA_FILE).text();
            const decisionsPath = process.env._DECISIONS;
            const decisions = existsSync(decisionsPath) ? await Bun.file(decisionsPath).text() : "No past tweet decisions yet.";
            const result = template
              .replace("X_DATA_PLACEHOLDER", data.trim())
              .replace("TWEET_DECISIONS_PLACEHOLDER", decisions.trim());
            await Bun.write(process.env._OUT, result);
            ' 2>> "${LOG_FILE}" || true

            # Run Claude for engagement (120s timeout)
            XENG_TIMEOUT=120
            log "Phase 0b: Running Claude for engagement draft (timeout=${XENG_TIMEOUT}s)..."
            setsid claude -p - --model sonnet --output-format stream-json --verbose                 < "${XENG_PROMPT_FILE}" > "${XENG_STREAM_FILE}" 2>> "${LOG_FILE}" &
            XENG_CLAUDE_PID=$!
            XENG_WALL_START=$(date +%s)

            while kill -0 "${XENG_CLAUDE_PID}" 2>/dev/null; do
                sleep 5
                XENG_ELAPSED=$(( $(date +%s) - XENG_WALL_START ))
                if [[ "${XENG_ELAPSED}" -ge "${XENG_TIMEOUT}" ]]; then
                    log "Phase 0b: timeout (${XENG_ELAPSED}s) — killing"
                    kill -TERM -"${XENG_CLAUDE_PID}" 2>/dev/null || true
                    sleep 2
                    kill -KILL -"${XENG_CLAUDE_PID}" 2>/dev/null || true
                    break
                fi
            done
            wait "${XENG_CLAUDE_PID}" 2>/dev/null || true

            # Extract text from stream
            _STREAM="${XENG_STREAM_FILE}"             _OUT="${XENG_OUTPUT_FILE}"             bun -e '
            const lines = (await Bun.file(process.env._STREAM).text()).split("\n").filter(Boolean);
            const texts = [];
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
                  for (const block of ev.message.content) {
                    if (block.type === "text" && block.text) texts.push(block.text);
                  }
                }
              } catch {}
            }
            await Bun.write(process.env._OUT, texts.join("\n"));
            ' 2>> "${LOG_FILE}" || true

            # Extract json:x_engage
            XENG_JSON=""
            if [[ -f "${XENG_OUTPUT_FILE}" ]]; then
                XENG_JSON=$(_OUT="${XENG_OUTPUT_FILE}" bun -e '
                const text = await Bun.file(process.env._OUT).text();
                const blocks = [...text.matchAll(/```json:x_engage\n([\s\S]*?)\n```/g)];
                let result = "";
                for (const block of blocks) {
                  try { result = JSON.stringify(JSON.parse(block[1].trim())); } catch {}
                }
                if (result) console.log(result);
                ' 2>/dev/null) || true
            fi

            if [[ -n "${XENG_JSON}" ]]; then
                log "Phase 0b: Engage JSON: ${XENG_JSON}"
                if [[ -n "${SPA_TRIGGER_URL:-}" && -n "${SPA_TRIGGER_SECRET:-}" ]]; then
                    XENG_AUTH_FILE=$(mktemp /tmp/growth-xeng-auth-XXXXXX.conf)
                    XENG_BODY_FILE=$(mktemp /tmp/growth-xeng-body-XXXXXX.json)
                    chmod 0600 "${XENG_AUTH_FILE}" "${XENG_BODY_FILE}"
                    printf 'header = "Authorization: Bearer %s"\n' "${SPA_TRIGGER_SECRET}" > "${XENG_AUTH_FILE}"
                    printf '%s' "${XENG_JSON}" > "${XENG_BODY_FILE}"
                    XENG_HTTP=$(curl -s -o /dev/null -w "%{http_code}"                         -X POST "${SPA_TRIGGER_URL}/candidate"                         -K "${XENG_AUTH_FILE}"                         -H "Content-Type: application/json"                         --data-binary @"${XENG_BODY_FILE}"                         --max-time 30) || XENG_HTTP="000"
                    rm -f "${XENG_AUTH_FILE}" "${XENG_BODY_FILE}"
                    log "Phase 0b: SPA response: HTTP ${XENG_HTTP}"
                fi
            else
                log "Phase 0b: No json:x_engage block found"
            fi
        fi
    else
        log "Phase 0b: x-fetch.ts failed"
    fi
fi

# --- Phase 1: Batch fetch Reddit posts ---
log "Phase 1: Fetching Reddit posts..."

REDDIT_DATA_FILE=$(mktemp /tmp/growth-reddit-XXXXXX.json)
chmod 0600 "${REDDIT_DATA_FILE}"

if ! bun run "${SCRIPT_DIR}/reddit-fetch.ts" > "${REDDIT_DATA_FILE}" 2>> "${LOG_FILE}"; then
    log "ERROR: reddit-fetch.ts failed"
    exit 1
fi

POST_COUNT=$(_DATA_FILE="${REDDIT_DATA_FILE}" bun -e 'const d=JSON.parse(await Bun.file(process.env._DATA_FILE).text()); console.log(d.postsScanned ?? d.posts?.length ?? 0)')
log "Phase 1 done: ${POST_COUNT} posts fetched"

# --- Phase 2: Score with Claude ---
log "Phase 2: Scoring with Claude..."

PROMPT_FILE=$(mktemp /tmp/growth-prompt-XXXXXX.md)
chmod 0600 "${PROMPT_FILE}"
PROMPT_TEMPLATE="${SCRIPT_DIR}/growth-prompt.md"

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
    log "ERROR: growth-prompt.md not found at $PROMPT_TEMPLATE"
    exit 1
fi

# Inject Reddit data into prompt template.
# Paths are passed via env vars — never interpolated into the JS string — per
# .claude/rules/shell-scripts.md ("Pass data to bun via environment variables").
DECISIONS_FILE="${HOME}/.config/spawn/growth-decisions.md"
_TEMPLATE="${PROMPT_TEMPLATE}" \
_DATA_FILE="${REDDIT_DATA_FILE}" \
_DECISIONS="${DECISIONS_FILE}" \
_OUT="${PROMPT_FILE}" \
bun -e '
import { existsSync } from "node:fs";
const template = await Bun.file(process.env._TEMPLATE).text();
const data = await Bun.file(process.env._DATA_FILE).text();
const decisionsPath = process.env._DECISIONS;
const decisions = existsSync(decisionsPath) ? await Bun.file(decisionsPath).text() : "No past decisions yet.";
const result = template
  .replace("REDDIT_DATA_PLACEHOLDER", data.trim())
  .replace("DECISIONS_PLACEHOLDER", decisions.trim());
await Bun.write(process.env._OUT, result);
'

log "Hard timeout: ${HARD_TIMEOUT}s"

# Run claude with stream-json to capture text (plain -p stdout is empty with extended thinking)
CLAUDE_STREAM_FILE=$(mktemp /tmp/growth-stream-XXXXXX.jsonl)
CLAUDE_OUTPUT_FILE=$(mktemp /tmp/growth-output-XXXXXX.txt)
# Run claude in its own session/process group (setsid) so we can signal the
# whole tree atomically via `kill -SIG -PGID` instead of racing with pkill -P.
setsid claude -p - --model sonnet --output-format stream-json --verbose \
    < "${PROMPT_FILE}" > "${CLAUDE_STREAM_FILE}" 2>> "${LOG_FILE}" &
CLAUDE_PID=$!
log "Claude started (pid=${CLAUDE_PID}, pgid=${CLAUDE_PID})"

# Kill claude and its full process tree by signalling the process group.
# Guards against empty/non-numeric CLAUDE_PID (defensive — should never happen).
kill_claude() {
    if [[ -z "${CLAUDE_PID:-}" ]] || ! [[ "${CLAUDE_PID}" =~ ^[0-9]+$ ]]; then
        log "kill_claude: CLAUDE_PID is unset or non-numeric, skipping"
        return
    fi
    if kill -0 "${CLAUDE_PID}" 2>/dev/null; then
        log "Killing claude process group (pgid=${CLAUDE_PID})"
        kill -TERM -"${CLAUDE_PID}" 2>/dev/null || true
        sleep 5
        kill -KILL -"${CLAUDE_PID}" 2>/dev/null || true
    fi
}

# Watchdog: wall-clock timeout
WALL_START=$(date +%s)

while kill -0 "${CLAUDE_PID}" 2>/dev/null; do
    sleep 10
    WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

    if [[ "${WALL_ELAPSED}" -ge "${HARD_TIMEOUT}" ]]; then
        log "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
        kill_claude
        break
    fi
done

wait "${CLAUDE_PID}" 2>/dev/null
CLAUDE_EXIT=$?

# Extract text content from stream-json into plain text output file.
_STREAM="${CLAUDE_STREAM_FILE}" \
_OUT="${CLAUDE_OUTPUT_FILE}" \
bun -e '
const lines = (await Bun.file(process.env._STREAM).text()).split("\n").filter(Boolean);
const texts = [];
for (const line of lines) {
  try {
    const ev = JSON.parse(line);
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block.type === "text" && block.text) texts.push(block.text);
      }
    }
  } catch {}
}
await Bun.write(process.env._OUT, texts.join("\n"));
' 2>> "${LOG_FILE}" || true

# Append Claude output to log
cat "${CLAUDE_OUTPUT_FILE}" >> "${LOG_FILE}" 2>/dev/null || true

if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
    log "Phase 2 done: scoring completed"
else
    log "Phase 2 failed (exit_code=${CLAUDE_EXIT})"
fi

# --- Phase 3: Extract candidate and POST to SPA ---
CANDIDATE_JSON=""

# Extract the last valid json:candidate block from Claude's output
if [[ -f "${CLAUDE_OUTPUT_FILE}" ]]; then
    CANDIDATE_JSON=$(_OUT="${CLAUDE_OUTPUT_FILE}" bun -e '
const text = await Bun.file(process.env._OUT).text();
const blocks = [...text.matchAll(/```json:candidate\n([\s\S]*?)\n```/g)];
let result = "";
for (const block of blocks) {
  try { result = JSON.stringify(JSON.parse(block[1].trim())); } catch {}
}
if (result) console.log(result);
' 2>/dev/null)
fi

if [[ -z "${CANDIDATE_JSON}" ]]; then
    log "No json:candidate block found in output"
    CANDIDATE_JSON="{\"found\":false,\"postsScanned\":${POST_COUNT}}"
fi

log "Candidate JSON: ${CANDIDATE_JSON}"

# POST to SPA if SPA_TRIGGER_URL is configured.
# Secret + body are written to 0600 temp files so SPA_TRIGGER_SECRET never
# appears on the curl command line (visible via ps / /proc/*/cmdline).
if [[ -n "${SPA_TRIGGER_URL:-}" && -n "${SPA_TRIGGER_SECRET:-}" ]]; then
    log "Posting candidate to SPA at ${SPA_TRIGGER_URL}/candidate"
    SPA_AUTH_FILE=$(mktemp /tmp/growth-auth-XXXXXX.conf)
    SPA_BODY_FILE=$(mktemp /tmp/growth-body-XXXXXX.json)
    chmod 0600 "${SPA_AUTH_FILE}" "${SPA_BODY_FILE}"
    printf 'header = "Authorization: Bearer %s"\n' "${SPA_TRIGGER_SECRET}" > "${SPA_AUTH_FILE}"
    printf '%s' "${CANDIDATE_JSON}" > "${SPA_BODY_FILE}"
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "${SPA_TRIGGER_URL}/candidate" \
        -K "${SPA_AUTH_FILE}" \
        -H "Content-Type: application/json" \
        --data-binary @"${SPA_BODY_FILE}" \
        --max-time 30) || HTTP_STATUS="000"
    rm -f "${SPA_AUTH_FILE}" "${SPA_BODY_FILE}"
    log "SPA response: HTTP ${HTTP_STATUS}"
else
    log "SPA_TRIGGER_URL or SPA_TRIGGER_SECRET not set, skipping Slack notification"
fi

rm -f "${CLAUDE_OUTPUT_FILE}" "${CLAUDE_STREAM_FILE}" 2>/dev/null || true
