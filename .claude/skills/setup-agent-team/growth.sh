#!/bin/bash
set -eo pipefail

# Reddit Growth Agent — Single Cycle (Discovery Only)
# Phase 1: Batch-fetch Reddit posts via reddit-fetch.ts (fast, parallel)
# Phase 2: Pass results to Claude for scoring/qualification (no tool use)
# Phase 3: POST candidate to SPA for Slack notification

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

SPAWN_REASON="${SPAWN_REASON:-manual}"
TEAM_NAME="spawn-growth"
HARD_TIMEOUT=1800  # 30 min (claude scoring can take 10+ min with 500+ post sets)

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
          "${CLAUDE_OUTPUT_FILE:-}" "${SPA_AUTH_FILE:-}" "${SPA_BODY_FILE:-}" 2>/dev/null || true
    if [[ -n "${CLAUDE_PID:-}" ]] && kill -0 "${CLAUDE_PID}" 2>/dev/null; then
        kill -TERM "${CLAUDE_PID}" 2>/dev/null || true
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
