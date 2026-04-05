#!/bin/bash
set -eo pipefail

# Reddit Growth Agent — Single Cycle (Discovery Only)
# Triggered by trigger-server.ts via GitHub Actions (daily)
#
# Scans Reddit for "feature ask" threads that Spawn solves,
# qualifies the poster, picks the 1 best candidate, and outputs
# a summary to the log. Does NOT post replies or notify externally.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

SPAWN_REASON="${SPAWN_REASON:-manual}"
TEAM_NAME="spawn-growth"
CYCLE_TIMEOUT=1800   # 30 min
HARD_TIMEOUT=2400    # 40 min grace

LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] [growth] $*" | tee -a "${LOG_FILE}"
}

# --- Safe sed substitution (escapes sed metacharacters in replacement) ---
safe_substitute() {
    local placeholder="$1"
    local value="$2"
    local file="$3"
    if printf '%s' "$value" | grep -qP '\x01'; then
        log "ERROR: safe_substitute value contains illegal \\x01 character"
        return 1
    fi
    local escaped
    escaped=$(printf '%s' "$value" | sed -e 's/[\\]/\\&/g' -e 's/[&]/\\&/g')
    escaped="${escaped//$'\n'/\\$'\n'}"
    sed -i.bak "s$(printf '\x01')${placeholder}$(printf '\x01')${escaped}$(printf '\x01')g" "$file"
    rm -f "${file}.bak"
}

# Cleanup function
cleanup() {
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1

    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."

    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true
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
log "Timeout: ${CYCLE_TIMEOUT}s"

# Fetch latest refs
log "Fetching latest refs..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

# Update Claude Code to latest version
log "Updating Claude Code..."
claude update --yes 2>&1 | tee -a "${LOG_FILE}" || log "WARNING: Claude Code update failed (continuing with current version)"

# Prepare prompt
log "Launching growth cycle..."

PROMPT_FILE=$(mktemp /tmp/growth-prompt-XXXXXX.md)
chmod 0600 "${PROMPT_FILE}"
PROMPT_TEMPLATE="${SCRIPT_DIR}/growth-prompt.md"

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
    log "ERROR: growth-prompt.md not found at $PROMPT_TEMPLATE"
    exit 1
fi

cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

# Substitute env vars into prompt
safe_substitute "REDDIT_CLIENT_ID_PLACEHOLDER" "${REDDIT_CLIENT_ID:-}" "${PROMPT_FILE}"
safe_substitute "REDDIT_CLIENT_SECRET_PLACEHOLDER" "${REDDIT_CLIENT_SECRET:-}" "${PROMPT_FILE}"
safe_substitute "REDDIT_USERNAME_PLACEHOLDER" "${REDDIT_USERNAME:-}" "${PROMPT_FILE}"
safe_substitute "REDDIT_PASSWORD_PLACEHOLDER" "${REDDIT_PASSWORD:-}" "${PROMPT_FILE}"

log "Hard timeout: ${HARD_TIMEOUT}s"

# Run claude in background
claude -p - --dangerously-skip-permissions --model sonnet < "${PROMPT_FILE}" >> "${LOG_FILE}" 2>&1 &
CLAUDE_PID=$!
log "Claude started (pid=${CLAUDE_PID})"

# Kill claude and its full process tree
kill_claude() {
    if kill -0 "${CLAUDE_PID}" 2>/dev/null; then
        log "Killing claude (pid=${CLAUDE_PID}) and its process tree"
        pkill -TERM -P "${CLAUDE_PID}" 2>/dev/null || true
        kill -TERM "${CLAUDE_PID}" 2>/dev/null || true
        sleep 5
        pkill -KILL -P "${CLAUDE_PID}" 2>/dev/null || true
        kill -KILL "${CLAUDE_PID}" 2>/dev/null || true
    fi
}

# Watchdog: wall-clock timeout
WALL_START=$(date +%s)

while kill -0 "${CLAUDE_PID}" 2>/dev/null; do
    sleep 30
    WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

    if [[ "${WALL_ELAPSED}" -ge "${HARD_TIMEOUT}" ]]; then
        log "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
        kill_claude
        break
    fi
done

wait "${CLAUDE_PID}" 2>/dev/null
CLAUDE_EXIT=$?

if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
    log "Cycle completed successfully"
else
    log "Cycle failed (exit_code=${CLAUDE_EXIT})"
fi

# --- Extract candidate JSON and POST to SPA ---
CANDIDATE_JSON=""

# Extract the json:candidate block from the log (between ```json:candidate and ```)
if [[ -f "${LOG_FILE}" ]]; then
    CANDIDATE_JSON=$(sed -n '/^```json:candidate$/,/^```$/{/^```/d;p;}' "${LOG_FILE}" | tail -1)
fi

if [[ -z "${CANDIDATE_JSON}" ]]; then
    log "No json:candidate block found in output"
    CANDIDATE_JSON='{"found":false}'
fi

log "Candidate JSON: ${CANDIDATE_JSON}"

# POST to SPA if SPA_TRIGGER_URL is configured
if [[ -n "${SPA_TRIGGER_URL:-}" && -n "${SPA_TRIGGER_SECRET:-}" ]]; then
    log "Posting candidate to SPA at ${SPA_TRIGGER_URL}/candidate"
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "${SPA_TRIGGER_URL}/candidate" \
        -H "Authorization: Bearer ${SPA_TRIGGER_SECRET}" \
        -H "Content-Type: application/json" \
        --data-binary @- <<< "${CANDIDATE_JSON}" \
        --max-time 30) || HTTP_STATUS="000"
    log "SPA response: HTTP ${HTTP_STATUS}"
else
    log "SPA_TRIGGER_URL or SPA_TRIGGER_SECRET not set, skipping Slack notification"
fi
