#!/bin/bash
set -eo pipefail

# QA Service — Single Cycle (Quad-Mode)
# Triggered by trigger-server.ts via GitHub Actions
#
# RUN_MODE=quality  — agent team: test-runner + dedup-scanner + code-quality-reviewer + e2e-tester (reason=schedule/workflow_dispatch, 40 min)
# RUN_MODE=fixtures — single agent: collect API fixtures from cloud providers (reason=fixtures, 20 min)
# RUN_MODE=issue    — single agent: investigate and fix a specific issue (reason=issues, 15 min)
# RUN_MODE=e2e      — single agent: run AWS E2E tests, investigate failures (reason=e2e, 20 min)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

# --- Run mode detection ---
SPAWN_ISSUE="${SPAWN_ISSUE:-}"
SPAWN_REASON="${SPAWN_REASON:-manual}"

# Validate SPAWN_ISSUE is a positive integer to prevent command injection
if [[ -n "${SPAWN_ISSUE}" ]] && [[ ! "${SPAWN_ISSUE}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: SPAWN_ISSUE must be a positive integer, got: '${SPAWN_ISSUE}'" >&2
    exit 1
fi

if [[ "${SPAWN_REASON}" == "e2e" ]]; then
    RUN_MODE="e2e"
    WORKTREE_BASE="/tmp/spawn-worktrees/qa-e2e"
    TEAM_NAME="spawn-qa-e2e"
    CYCLE_TIMEOUT=1200  # 20 min for E2E tests + investigation
elif [[ "${SPAWN_REASON}" == "issues" ]] && [[ -n "${SPAWN_ISSUE}" ]]; then
    RUN_MODE="issue"
    ISSUE_NUM="${SPAWN_ISSUE}"
    WORKTREE_BASE="/tmp/spawn-worktrees/qa-issue-${ISSUE_NUM}"
    TEAM_NAME="spawn-qa-issue-${ISSUE_NUM}"
    CYCLE_TIMEOUT=900   # 15 min for issue fix
elif [[ "${SPAWN_REASON}" == "fixtures" ]]; then
    RUN_MODE="fixtures"
    WORKTREE_BASE="/tmp/spawn-worktrees/qa-fixtures"
    TEAM_NAME="spawn-qa-fixtures"
    CYCLE_TIMEOUT=1200  # 20 min for fixture collection
elif [[ "${SPAWN_REASON}" == "schedule" ]] || [[ "${SPAWN_REASON}" == "workflow_dispatch" ]] || [[ "${SPAWN_REASON}" == "manual" ]]; then
    RUN_MODE="quality"
    WORKTREE_BASE="/tmp/spawn-worktrees/qa-quality"
    TEAM_NAME="spawn-qa-quality"
    CYCLE_TIMEOUT=2400  # 40 min for quality sweep (includes E2E)
else
    RUN_MODE="quality"
    WORKTREE_BASE="/tmp/spawn-worktrees/qa-quality"
    TEAM_NAME="spawn-qa-quality"
    CYCLE_TIMEOUT=2400  # 40 min for quality sweep (includes E2E)
fi

LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    printf '[%s] [qa/%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "${RUN_MODE}" "$*" | tee -a "${LOG_FILE}"
}

# --- Safe sed substitution (escapes sed metacharacters in replacement) ---
# Usage: safe_substitute PLACEHOLDER VALUE FILE
# Replaces all occurrences of PLACEHOLDER with VALUE in FILE, escaping
# sed-special characters (\, &, |, newline) in VALUE to prevent misinterpretation.
safe_substitute() {
    local placeholder="$1"
    local value="$2"
    local file="$3"
    # Escape backslashes first, then &, then the delimiter |
    local escaped
    escaped=$(printf '%s' "$value" | sed -e 's/[\\]/\\&/g' -e 's/[&]/\\&/g' -e 's/[|]/\\|/g')
    sed -i.bak "s|${placeholder}|${escaped}|g" "$file"
    rm -f "${file}.bak"
}

# --- Validate branch name against safe pattern (defense-in-depth) ---
# Prevents command injection via shell metacharacters in branch names
is_safe_branch_name() {
    local name="${1:-}"
    [[ -n "${name}" ]] && [[ "${name}" =~ ^[a-zA-Z0-9._/-]+$ ]]
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
if [[ "${RUN_MODE}" == "issue" ]]; then
    log "Issue: #${ISSUE_NUM}"
fi

# Pre-cycle cleanup (stale branches, worktrees, test directories from prior runs)
log "Pre-cycle cleanup..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true

if [[ "${RUN_MODE}" == "quality" ]]; then
    # Quality mode syncs to latest main
    git pull --rebase origin main 2>&1 | tee -a "${LOG_FILE}" || true
fi

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

# Delete merged qa-related remote branches
MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -E 'origin/qa/' | sed 's|origin/||' | tr -d ' ') || true
for branch in $MERGED_BRANCHES; do
    if is_safe_branch_name "$branch"; then
        git push origin --delete -- "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted merged branch: $branch" || true
    else
        log "WARNING: Skipping branch with unsafe name: ${branch}"
    fi
done

# Delete stale local qa branches
LOCAL_BRANCHES=$(git branch --list 'qa/*' | tr -d ' *') || true
for branch in $LOCAL_BRANCHES; do
    if is_safe_branch_name "$branch"; then
        git branch -D -- "$branch" 2>&1 | tee -a "${LOG_FILE}" || true
    else
        log "WARNING: Skipping local branch with unsafe name: ${branch}"
    fi
done

log "Pre-cycle cleanup done."

# --- Fixtures mode: load cloud credentials ---
if [[ "${RUN_MODE}" == "fixtures" ]]; then
    if [[ -f "${REPO_ROOT}/sh/shared/key-request.sh" ]]; then
        source "${REPO_ROOT}/sh/shared/key-request.sh"
        load_cloud_keys_from_config
        if [[ -n "${MISSING_KEY_PROVIDERS:-}" ]]; then
            log "Missing keys for: ${MISSING_KEY_PROVIDERS}"
            if [[ -n "${KEY_SERVER_URL:-}" ]]; then
                log "Requesting keys via key-server..."
                request_missing_cloud_keys
            fi
        else
            log "All cloud keys available"
        fi
    else
        log "sh/shared/key-request.sh not found, skipping key preflight"
    fi
fi

# Launch Claude Code with mode-specific prompt
# Enable agent teams (required for team-based workflows)
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# Persist into .spawnrc so all Claude sessions on this VM inherit the flag
if [[ -f "${HOME}/.spawnrc" ]]; then
    grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "${HOME}/.spawnrc" 2>/dev/null || \
        printf '\nexport CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n' >> "${HOME}/.spawnrc"
fi

log "Launching ${RUN_MODE} cycle..."

PROMPT_FILE=$(mktemp /tmp/qa-prompt-XXXXXX.md)

if [[ "${RUN_MODE}" == "quality" ]]; then
    PROMPT_TEMPLATE="${SCRIPT_DIR}/qa-quality-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: qa-quality-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
    safe_substitute "REPO_ROOT_PLACEHOLDER" "${REPO_ROOT}" "${PROMPT_FILE}"

elif [[ "${RUN_MODE}" == "fixtures" ]]; then
    PROMPT_TEMPLATE="${SCRIPT_DIR}/qa-fixtures-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: qa-fixtures-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
    safe_substitute "REPO_ROOT_PLACEHOLDER" "${REPO_ROOT}" "${PROMPT_FILE}"

elif [[ "${RUN_MODE}" == "issue" ]]; then
    PROMPT_TEMPLATE="${SCRIPT_DIR}/qa-issue-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: qa-issue-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    safe_substitute "ISSUE_NUM_PLACEHOLDER" "${ISSUE_NUM}" "${PROMPT_FILE}"
    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
    safe_substitute "REPO_ROOT_PLACEHOLDER" "${REPO_ROOT}" "${PROMPT_FILE}"

elif [[ "${RUN_MODE}" == "e2e" ]]; then
    PROMPT_TEMPLATE="${SCRIPT_DIR}/qa-e2e-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: qa-e2e-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
    safe_substitute "REPO_ROOT_PLACEHOLDER" "${REPO_ROOT}" "${PROMPT_FILE}"

fi

# Add grace period: 5 min beyond the prompt timeout
HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))

log "Hard timeout: ${HARD_TIMEOUT}s"

# Run claude in background, output goes to log file.
claude -p "$(cat "${PROMPT_FILE}")" >> "${LOG_FILE}" 2>&1 &
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
