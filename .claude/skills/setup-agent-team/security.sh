#!/bin/bash
set -eo pipefail

# Security Review Team Service — Single Cycle (Quad-Mode)
# Triggered by trigger-server.ts via GitHub Actions
#
# RUN_MODE=team_building — implement team changes from issue (reason=team_building, 15 min)
# RUN_MODE=triage        — single-agent issue triage for prompt injection/spam (reason=triage, 5 min)
# RUN_MODE=review_all    — consolidated review + scan: batch PR review, hygiene, AND lightweight repo scan (reason=review_all, 35 min)
# RUN_MODE=scan          — full repo security scan + issue filing (reason=schedule, 20 min) — manual/workflow_dispatch only

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

# --- Run mode detection ---
SPAWN_ISSUE="${SPAWN_ISSUE:-}"
SPAWN_REASON="${SPAWN_REASON:-manual}"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"

# Validate SPAWN_ISSUE is a positive integer to prevent command injection
if [[ -n "${SPAWN_ISSUE}" ]] && [[ ! "${SPAWN_ISSUE}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: SPAWN_ISSUE must be a positive integer, got: '${SPAWN_ISSUE}'" >&2
    exit 1
fi

# Validate SLACK_WEBHOOK format to prevent sed delimiter injection via pipe chars
# Slack webhooks are: https://hooks.slack.com/services/T.../B.../xxx or /workflows/...
# Only allow alphanumeric, slashes, hyphens, and underscores in the path
if [[ -n "${SLACK_WEBHOOK}" ]]; then
    if [[ ! "${SLACK_WEBHOOK}" =~ ^https://hooks\.slack\.com/[a-zA-Z0-9/_-]+$ ]]; then
        echo "WARNING: SLACK_WEBHOOK contains invalid characters or wrong domain, disabling" >&2
        SLACK_WEBHOOK=""
    fi
fi

if [[ "${SPAWN_REASON}" == "issues" ]] && [[ -n "${SPAWN_ISSUE}" ]]; then
    # Workflow passed raw event_name — detect mode from issue labels
    if gh issue view "${SPAWN_ISSUE}" --repo OpenRouterTeam/spawn --json labels --jq '.labels[].name' 2>/dev/null | grep -q '^team-building$'; then
        RUN_MODE="team_building"
        ISSUE_NUM="${SPAWN_ISSUE}"
        WORKTREE_BASE="/tmp/spawn-worktrees/team-building-${ISSUE_NUM}"
        TEAM_NAME="spawn-team-building-${ISSUE_NUM}"
        CYCLE_TIMEOUT=900   # 15 min for team building
    else
        RUN_MODE="triage"
        ISSUE_NUM="${SPAWN_ISSUE}"
        WORKTREE_BASE="/tmp/spawn-worktrees/triage-${ISSUE_NUM}"
        TEAM_NAME="spawn-triage-${ISSUE_NUM}"
        CYCLE_TIMEOUT=600   # 10 min for issue triage
    fi
elif [[ "${SPAWN_REASON}" == "team_building" ]] && [[ -n "${SPAWN_ISSUE}" ]]; then
    # Legacy: direct team_building reason (backwards compat)
    RUN_MODE="team_building"
    ISSUE_NUM="${SPAWN_ISSUE}"
    WORKTREE_BASE="/tmp/spawn-worktrees/team-building-${ISSUE_NUM}"
    TEAM_NAME="spawn-team-building-${ISSUE_NUM}"
    CYCLE_TIMEOUT=900   # 15 min for team building
elif [[ "${SPAWN_REASON}" == "triage" ]] && [[ -n "${SPAWN_ISSUE}" ]]; then
    # Legacy: direct triage reason (backwards compat)
    RUN_MODE="triage"
    ISSUE_NUM="${SPAWN_ISSUE}"
    WORKTREE_BASE="/tmp/spawn-worktrees/triage-${ISSUE_NUM}"
    TEAM_NAME="spawn-triage-${ISSUE_NUM}"
    CYCLE_TIMEOUT=600   # 10 min for issue triage
elif [[ "${SPAWN_REASON}" == "review_all" ]]; then
    RUN_MODE="review_all"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-review-all"
    TEAM_NAME="spawn-security-review-all"
    CYCLE_TIMEOUT=2100  # 35 min for consolidated review + scan
elif [[ "${SPAWN_REASON}" == "schedule" ]] || [[ "${SPAWN_REASON}" == "workflow_dispatch" ]]; then
    # Cron and manual triggers run the consolidated review + scan
    RUN_MODE="review_all"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-review-all"
    TEAM_NAME="spawn-security-review-all"
    CYCLE_TIMEOUT=2100  # 35 min for consolidated review + scan
else
    RUN_MODE="scan"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-scan"
    TEAM_NAME="spawn-security-scan"
    CYCLE_TIMEOUT=1200  # 20 min for full repo scan
fi

LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] [${RUN_MODE}] $*" | tee -a "${LOG_FILE}"
}

# --- Safe sed substitution (escapes sed metacharacters in replacement) ---
# Usage: safe_substitute PLACEHOLDER VALUE FILE
safe_substitute() {
    local placeholder="$1"
    local value="$2"
    local file="$3"
    local escaped
    escaped=$(printf '%s' "$value" | sed -e 's/[\\]/\\&/g' -e 's/[&]/\\&/g' -e 's/[|]/\\|/g')
    sed -i.bak "s|${placeholder}|${escaped}|g" "$file"
    rm -f "${file}.bak"
}

# --- Safe rm -rf for worktree paths (defense-in-depth) ---
safe_rm_worktree() {
    local target="${1:-}"
    if [[ -z "${target}" ]]; then return; fi
    if [[ "${target}" != /tmp/spawn-worktrees/* ]]; then
        log "ERROR: Refusing to rm -rf: '${target}' is not under /tmp/spawn-worktrees/"
        return 1
    fi
    rm -rf "${target}" 2>/dev/null || true
}

# Cleanup function — runs on normal exit, SIGTERM, and SIGINT
cleanup() {
    # Guard against re-entry (SIGTERM trap calls exit, which fires EXIT trap again)
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1

    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."

    cd "${REPO_ROOT}" 2>/dev/null || true

    # Prune worktrees and clean up only OUR worktree base
    git worktree prune 2>/dev/null || true
    safe_rm_worktree "${WORKTREE_BASE}"

    # Clean up test directories from CLI integration tests
    TEST_DIR_COUNT=$(find "${HOME}" -maxdepth 1 -type d -name 'spawn-cmdlist-test-*' 2>/dev/null | wc -l)
    if [[ "${TEST_DIR_COUNT}" -gt 0 ]]; then
        log "Post-cycle cleanup: removing ${TEST_DIR_COUNT} test directories..."
        find "${HOME}" -maxdepth 1 -type d -name 'spawn-cmdlist-test-*' -exec rm -rf {} + 2>/dev/null || true
    fi

    # Clean up prompt file and kill claude if still running
    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true
    if [[ -n "${CLAUDE_PID:-}" ]] && kill -0 "${CLAUDE_PID}" 2>/dev/null; then
        kill -TERM "${CLAUDE_PID}" 2>/dev/null || true
    fi

    log "=== Cycle Done (exit_code=${exit_code}) ==="
    exit $exit_code
}

trap cleanup EXIT SIGTERM SIGINT

log "=== Starting ${RUN_MODE} cycle ==="
log "Working directory: ${REPO_ROOT}"
log "Team name: ${TEAM_NAME}"
log "Worktree base: ${WORKTREE_BASE}"
log "Timeout: ${CYCLE_TIMEOUT}s"
if [[ "${RUN_MODE}" == "team_building" ]] || [[ "${RUN_MODE}" == "triage" ]]; then
    log "Issue: #${ISSUE_NUM}"
fi

# Pre-cycle cleanup (stale branches, worktrees, test directories from prior runs)
log "Pre-cycle cleanup..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true
git pull --rebase origin main 2>&1 | tee -a "${LOG_FILE}" || true

# Clean stale worktrees
git worktree prune 2>&1 | tee -a "${LOG_FILE}" || true
if [[ -d "${WORKTREE_BASE}" ]]; then
    safe_rm_worktree "${WORKTREE_BASE}"
    log "Removed stale ${WORKTREE_BASE} directory"
fi

# Clean up test directories from CLI integration tests
TEST_DIR_COUNT=$(find "${HOME}" -maxdepth 1 -type d -name 'spawn-cmdlist-test-*' 2>/dev/null | wc -l)
if [[ "${TEST_DIR_COUNT}" -gt 0 ]]; then
    log "Cleaning up ${TEST_DIR_COUNT} stale test directories..."
    find "${HOME}" -maxdepth 1 -type d -name 'spawn-cmdlist-test-*' -exec rm -rf {} + 2>&1 | tee -a "${LOG_FILE}" || true
    log "Test directory cleanup complete"
fi

# Delete merged security-related remote branches (team-building/*, review-pr-*)
MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -E 'origin/(team-building/|review-pr-)' | sed 's|origin/||' | tr -d ' ') || true
for branch in $MERGED_BRANCHES; do
    if [[ -n "$branch" ]]; then
        git push origin --delete "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted merged branch: $branch" || true
    fi
done

# Delete stale local security-related branches
LOCAL_BRANCHES=$(git branch --list 'team-building/*' --list 'review-pr-*' | tr -d ' *') || true
for branch in $LOCAL_BRANCHES; do
    if [[ -n "$branch" ]]; then
        git branch -D "$branch" 2>&1 | tee -a "${LOG_FILE}" || true
    fi
done

log "Pre-cycle cleanup done."

# Launch Claude Code with mode-specific prompt
# Enable agent teams (required for team-based workflows)
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# Persist into .spawnrc so all Claude sessions on this VM inherit the flag
if [[ -f "${HOME}/.spawnrc" ]]; then
    grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "${HOME}/.spawnrc" 2>/dev/null || \
        printf '\nexport CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n' >> "${HOME}/.spawnrc"
fi

log "Launching ${RUN_MODE} cycle..."

PROMPT_FILE=$(mktemp /tmp/security-prompt-XXXXXX.md)

if [[ "${RUN_MODE}" == "team_building" ]]; then
    # --- Team Building mode: implement changes to agent team scripts ---
    PROMPT_TEMPLATE="${SCRIPT_DIR}/security-team-building-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: security-team-building-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    # Substitute placeholders with validated values
    safe_substitute "ISSUE_NUM_PLACEHOLDER" "${ISSUE_NUM}" "${PROMPT_FILE}"
    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"

elif [[ "${RUN_MODE}" == "triage" ]]; then
    # --- Triage mode: single-agent issue safety check ---
    PROMPT_TEMPLATE="${SCRIPT_DIR}/security-triage-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: security-triage-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    # Substitute placeholders with validated values
    safe_substitute "ISSUE_NUM_PLACEHOLDER" "${ISSUE_NUM}" "${PROMPT_FILE}"
    safe_substitute "SLACK_WEBHOOK_PLACEHOLDER" "${SLACK_WEBHOOK:-NOT_SET}" "${PROMPT_FILE}"

elif [[ "${RUN_MODE}" == "review_all" ]]; then
    # --- Review-all mode: batch security review + hygiene for ALL open PRs ---
    PROMPT_TEMPLATE="${SCRIPT_DIR}/security-review-all-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: security-review-all-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    # Substitute placeholders with validated values
    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
    safe_substitute "REPO_ROOT_PLACEHOLDER" "${REPO_ROOT}" "${PROMPT_FILE}"
    safe_substitute "SLACK_WEBHOOK_PLACEHOLDER" "${SLACK_WEBHOOK:-NOT_SET}" "${PROMPT_FILE}"
    if [ -n "${SLACK_WEBHOOK:-}" ]; then
        SLACK_STATUS="yes"
    else
        SLACK_STATUS="no"
    fi
    safe_substitute "SLACK_WEBHOOK_STATUS_PLACEHOLDER" "${SLACK_STATUS}" "${PROMPT_FILE}"

else
    # --- Scan mode: full repo security audit + issue filing ---
    PROMPT_TEMPLATE="${SCRIPT_DIR}/security-scan-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: security-scan-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    # Substitute placeholders with validated values
    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
    safe_substitute "REPO_ROOT_PLACEHOLDER" "${REPO_ROOT}" "${PROMPT_FILE}"
    safe_substitute "SLACK_WEBHOOK_PLACEHOLDER" "${SLACK_WEBHOOK:-NOT_SET}" "${PROMPT_FILE}"

fi

# Add grace period: pr=5min, hygiene=5min, scan=5min beyond the prompt timeout
HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))

log "Hard timeout: ${HARD_TIMEOUT}s"

# Run claude in background, output goes to log file.
# Triage uses gemini-3-flash (lightweight safety check); other modes use default (Opus) for team lead.
CLAUDE_MODEL_FLAG=""
if [[ "${RUN_MODE}" == "triage" ]]; then
    CLAUDE_MODEL_FLAG="--model google/gemini-3-flash-preview"
fi

claude -p "$(cat "${PROMPT_FILE}")" ${CLAUDE_MODEL_FLAG} >> "${LOG_FILE}" 2>&1 &
CLAUDE_PID=$!
log "Claude started (pid=${CLAUDE_PID})"

# Kill claude and its full process tree reliably
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

# Watchdog: wall-clock timeout as safety net
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

# Note: cleanup (worktree prune, prompt file removal, final log) handled by trap
