#!/bin/bash
set -eo pipefail

# Refactoring Team Service — Single Cycle (Dual-Mode)
# Triggered by trigger-server.ts via GitHub Actions
#
# RUN_MODE=issue   — lightweight 2-teammate fix for a specific GitHub issue (15 min)
# RUN_MODE=refactor — full 6-teammate team for codebase maintenance (30 min)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

# --- Run mode detection ---
SPAWN_ISSUE="${SPAWN_ISSUE:-}"
SPAWN_REASON="${SPAWN_REASON:-manual}"

# Validate SPAWN_ISSUE is a positive integer to prevent command injection
# Check both for valid format AND ensure it's not an empty string that passes -n check
if [[ -n "${SPAWN_ISSUE}" ]] && [[ ! "${SPAWN_ISSUE}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: SPAWN_ISSUE must be a positive integer (1 or greater), got: '${SPAWN_ISSUE}'" >&2
    exit 1
fi

if [[ -n "${SPAWN_ISSUE}" ]]; then
    RUN_MODE="issue"
    WORKTREE_BASE="/tmp/spawn-worktrees/issue-${SPAWN_ISSUE}"
    TEAM_NAME="spawn-issue-${SPAWN_ISSUE}"
    CYCLE_TIMEOUT=900   # 15 min for issue runs
else
    RUN_MODE="refactor"
    WORKTREE_BASE="/tmp/spawn-worktrees/refactor"
    TEAM_NAME="spawn-refactor"
    CYCLE_TIMEOUT=1500  # 25 min for refactor runs
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

    # Capture exit code before any operations that could change it
    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."

    cd "${REPO_ROOT}" 2>/dev/null || true

    # Prune worktrees and clean up only OUR worktree base
    git worktree prune 2>/dev/null || true
    safe_rm_worktree "${WORKTREE_BASE}"

    # Clean up prompt and PID files
    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true
    # Kill claude if still running during cleanup
    if [[ -n "${CLAUDE_PID:-}" ]] && kill -0 "${CLAUDE_PID}" 2>/dev/null; then
        kill -TERM "${CLAUDE_PID}" 2>/dev/null || true
    fi

    log "=== Cycle Done (exit_code=${exit_code}) ==="
    # Exit with the captured code to preserve the original error
    exit ${exit_code}
}

trap cleanup EXIT SIGTERM SIGINT

log "=== Starting ${RUN_MODE} cycle ==="
log "Working directory: ${REPO_ROOT}"
log "Team name: ${TEAM_NAME}"
log "Worktree base: ${WORKTREE_BASE}"
log "Timeout: ${CYCLE_TIMEOUT}s"
if [[ "${RUN_MODE}" == "issue" ]]; then
    log "Issue: #${SPAWN_ISSUE}"
fi

# Fetch latest refs and sync to latest main (required for both modes)
log "Fetching latest refs..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

# Pre-cycle cleanup only in refactor mode (issue runs skip housekeeping)
if [[ "${RUN_MODE}" == "refactor" ]]; then

    log "Pre-cycle cleanup: stale worktrees and branches..."
    git worktree prune 2>&1 | tee -a "${LOG_FILE}" || true
    if [[ -d "${WORKTREE_BASE}" ]]; then
        safe_rm_worktree "${WORKTREE_BASE}"
        log "Removed stale ${WORKTREE_BASE} directory"
    fi

    # Delete merged refactor-related remote branches (fix/*, refactor/*, test/*, ux/*)
    MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -v 'origin/main\|origin/HEAD' | grep -E 'origin/(fix/|refactor/|test/|ux/)' | sed 's|origin/||' | tr -d ' ') || true
    for branch in $MERGED_BRANCHES; do
        if is_safe_branch_name "$branch"; then
            git push origin --delete -- "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted merged branch: $branch" || true
        else
            log "WARNING: Skipping branch with unsafe name: ${branch}"
        fi
    done

    # Delete stale local refactor-related branches
    LOCAL_BRANCHES=$(git branch --list 'fix/*' --list 'refactor/*' --list 'test/*' --list 'ux/*' | tr -d ' *') || true
    for branch in $LOCAL_BRANCHES; do
        if is_safe_branch_name "$branch"; then
            git branch -D -- "$branch" 2>&1 | tee -a "${LOG_FILE}" || true
        else
            log "WARNING: Skipping local branch with unsafe name: ${branch}"
        fi
    done

    log "Pre-cycle cleanup done."
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

PROMPT_FILE=$(mktemp /tmp/refactor-prompt-XXXXXX.md)

if [[ "${RUN_MODE}" == "issue" ]]; then
    # --- Issue mode: lightweight 2-teammate fix ---
    PROMPT_TEMPLATE="${SCRIPT_DIR}/refactor-issue-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: refactor-issue-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    # Substitute placeholders with validated values
    safe_substitute "SPAWN_ISSUE_PLACEHOLDER" "${SPAWN_ISSUE}" "${PROMPT_FILE}"
    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"

else
    # --- Refactor mode: full 6-teammate team ---
    PROMPT_TEMPLATE="${SCRIPT_DIR}/refactor-team-prompt.md"
    if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
        log "ERROR: refactor-team-prompt.md not found at $PROMPT_TEMPLATE"
        exit 1
    fi
    cat "$PROMPT_TEMPLATE" > "${PROMPT_FILE}"

    # Substitute WORKTREE_BASE_PLACEHOLDER with actual worktree path
    safe_substitute "WORKTREE_BASE_PLACEHOLDER" "${WORKTREE_BASE}" "${PROMPT_FILE}"
fi

# Add grace period: issue=5min, refactor=10min beyond the prompt timeout
if [[ "${RUN_MODE}" == "issue" ]]; then
    HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))   # 15 + 5 = 20 min
else
    HARD_TIMEOUT=$((CYCLE_TIMEOUT + 600))   # 25 + 10 = 35 min
fi

log "Hard timeout: ${HARD_TIMEOUT}s"

# Run claude in background, output goes to log file.
# The trigger server is fire-and-forget — VM keep-alive is handled by systemd.
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

    # Direct commit to main only in refactor mode
    if [[ "${RUN_MODE}" == "refactor" ]]; then
        if [[ -n "$(git status --porcelain)" ]]; then
            log "Committing changes from cycle..."
            # Stage everything EXCEPT protected paths using git pathspec exclusions
            git add -A -- ':!.github/workflows/' ':!.claude/skills/' ':!CLAUDE.md'

            if [[ -n "$(git diff --cached --name-only)" ]]; then
                git commit -m "refactor: Automated improvements

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" 2>&1 | tee -a "${LOG_FILE}" || true

                # Push to main
                git push origin main 2>&1 | tee -a "${LOG_FILE}" || true
            else
                log "Only off-limits files were changed — skipping commit"
            fi
        fi
    fi

else
    log "Cycle failed (exit_code=${CLAUDE_EXIT})"
fi

# Note: cleanup (worktree prune, prompt file removal, final log) handled by trap
