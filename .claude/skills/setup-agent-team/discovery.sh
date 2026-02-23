#!/bin/bash
# Community demand discovery team for spawn
#
# Researches community demand for new clouds/agents, creates proposal issues,
# tracks upvotes, and implements proposals that hit the 50-upvote threshold.
#
# Usage:
#   ./discovery.sh                  # one team cycle
#   ./discovery.sh --loop           # continuous cycles
#   ./discovery.sh --single         # single-agent mode (no teams)

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MANIFEST="${REPO_ROOT}/manifest.json"
MODE="${1:-once}"

# --- Lifecycle config ---
WORKTREE_BASE="/tmp/spawn-worktrees/discovery"
TEAM_NAME="spawn-discovery"
LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { printf "${GREEN}[discovery]${NC} %s\n" "$1"; echo "[$(date +'%Y-%m-%d %H:%M:%S')] [discovery] $1" >> "${LOG_FILE}"; }
log_warn()  { printf "${YELLOW}[discovery]${NC} %s\n" "$1"; echo "[$(date +'%Y-%m-%d %H:%M:%S')] [discovery] WARN: $1" >> "${LOG_FILE}"; }
log_error() { printf "${RED}[discovery]${NC} %s\n" "$1"; echo "[$(date +'%Y-%m-%d %H:%M:%S')] [discovery] ERROR: $1" >> "${LOG_FILE}"; }

# --- Safe rm -rf for worktree paths (defense-in-depth) ---
safe_rm_worktree() {
    local target="${1:-}"
    if [[ -z "${target}" ]]; then return; fi
    if [[ "${target}" != /tmp/spawn-worktrees/* ]]; then
        log_error "Refusing to rm -rf: '${target}' is not under /tmp/spawn-worktrees/"
        return 1
    fi
    rm -rf "${target}" 2>/dev/null || true
}

# --- Cleanup trap ---
cleanup() {
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1
    local exit_code=$?
    log_info "Running cleanup (exit_code=${exit_code})..."
    cd "${REPO_ROOT}" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    safe_rm_worktree "${WORKTREE_BASE}"
    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true
    log_info "=== Cycle Done (exit_code=${exit_code}) ==="
    exit $exit_code
}
trap cleanup EXIT SIGTERM SIGINT

# Check prerequisites
if ! command -v claude &>/dev/null; then
    log_error "Claude Code is required. Install: curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
fi

if ! command -v jq &>/dev/null; then
    log_error "jq is required for manifest parsing"
    exit 1
fi

if [[ ! -f "${MANIFEST}" ]]; then
    log_error "manifest.json not found at ${MANIFEST}"
    exit 1
fi

export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# Persist into .spawnrc so all Claude sessions on this VM inherit the flag
if [[ -f "${HOME}/.spawnrc" ]]; then
    grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "${HOME}/.spawnrc" 2>/dev/null || \
        printf '\nexport CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n' >> "${HOME}/.spawnrc"
fi

get_matrix_summary() {
    local agents clouds impl total gaps gap_count gap_list
    agents=$(jq -r '.agents | keys | join(", ")' "${MANIFEST}")
    clouds=$(jq -r '.clouds | keys | join(", ")' "${MANIFEST}")
    local agent_count cloud_count
    agent_count=$(jq '.agents | keys | length' "${MANIFEST}")
    cloud_count=$(jq '.clouds | keys | length' "${MANIFEST}")
    impl=$(jq '[.matrix | to_entries[] | select(.value == "implemented")] | length' "${MANIFEST}")
    total=$((agent_count * cloud_count))
    gap_list=$(jq -r '[.matrix | to_entries[] | select(.value == "missing") | .key] | join(", ")' "${MANIFEST}")
    gap_count=$(jq '[.matrix | to_entries[] | select(.value == "missing")] | length' "${MANIFEST}")

    printf 'Matrix: %s agents x %s clouds = %s/%s implemented\n' "$agent_count" "$cloud_count" "$impl" "$total"
    if [[ "$gap_count" -gt 0 ]]; then
        printf 'Gaps (%s): %s\n' "$gap_count" "$gap_list"
    else
        printf 'Matrix is full\n'
    fi
    printf 'Agents: %s\n' "$agents"
    printf 'Clouds: %s\n' "$clouds"
}

# Cleanup stale worktrees, branches, and related state
_cleanup_stale_artifacts() {
    log_info "Pre-cycle cleanup..."
    git worktree prune 2>/dev/null || true
    if [[ -d "${WORKTREE_BASE}" ]]; then
        safe_rm_worktree "${WORKTREE_BASE}"
        log_info "Removed stale ${WORKTREE_BASE} directory"
    fi

    local MERGED_BRANCHES
    MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -v 'origin/main\|origin/HEAD' | grep -E 'origin/(add-|impl-|gap-filler-)' | sed 's|origin/||' | tr -d ' ') || true
    for branch in $MERGED_BRANCHES; do
        if [[ -n "$branch" ]]; then
            git push origin --delete "$branch" 2>&1 && log_info "Deleted merged branch: $branch" || true
        fi
    done

    log_info "Pre-cycle cleanup done."
}

_prepare_prompt_file() {
    local output_file="$1"
    local prompt_template="${SCRIPT_DIR}/discovery-team-prompt.md"
    if [[ ! -f "$prompt_template" ]]; then
        log_error "discovery-team-prompt.md not found at $prompt_template"
        exit 1
    fi
    cat "$prompt_template" > "${output_file}"

    local summary
    summary=$(get_matrix_summary)
    # Replace placeholder with matrix summary (may contain newlines/special chars)
    _SUMMARY="${summary}" _FILE="${output_file}" jq -Rrn '
      [inputs] | join("\n") |
      gsub("MATRIX_SUMMARY_PLACEHOLDER"; env._SUMMARY)
    ' "${output_file}" > "${output_file}.tmp" && mv "${output_file}.tmp" "${output_file}"

    sed -i "s|WORKTREE_BASE_PLACEHOLDER|${WORKTREE_BASE}|g" "${output_file}"
}

# Kill claude process and its full process tree
_kill_claude_process() {
    local cpid="$1"
    if kill -0 "${cpid}" 2>/dev/null; then
        log_info "Killing claude (pid=${cpid}) and its process tree"
        pkill -TERM -P "${cpid}" 2>/dev/null || true
        kill -TERM "${cpid}" 2>/dev/null || true
        sleep 5
        pkill -KILL -P "${cpid}" 2>/dev/null || true
        kill -KILL "${cpid}" 2>/dev/null || true
    fi
}

# Watchdog: wall-clock timeout as safety net
_run_watchdog_loop() {
    local claude_pid="$1"
    local hard_timeout="$2"

    local WALL_START
    WALL_START=$(date +%s)

    while kill -0 "${claude_pid}" 2>/dev/null; do
        sleep 30
        local WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

        if [[ "${WALL_ELAPSED}" -ge "${hard_timeout}" ]]; then
            log_warn "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
            _kill_claude_process "${claude_pid}"
            break
        fi
    done

    wait "${claude_pid}" 2>/dev/null
    echo $?
}

_sync_and_setup() {
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    _cleanup_stale_artifacts
    mkdir -p "${WORKTREE_BASE}"

    PROMPT_FILE=$(mktemp /tmp/discovery-prompt-XXXXXX.md)
    _prepare_prompt_file "${PROMPT_FILE}"
}

run_team_cycle() {
    _sync_and_setup

    log_info "Launching discovery team..."
    log_info "Worktree base: ${WORKTREE_BASE}"
    echo ""

    local HARD_TIMEOUT=3600 # 60 min wall-clock safety net

    log_info "Hard timeout: ${HARD_TIMEOUT}s"

    claude -p "$(cat "${PROMPT_FILE}")" --dangerously-skip-permissions --model sonnet \
        >> "${LOG_FILE}" 2>&1 &

    local CLAUDE_PID=$!
    log_info "Claude started (pid=${CLAUDE_PID})"

    _run_watchdog_loop "${CLAUDE_PID}" "${HARD_TIMEOUT}"
    local CLAUDE_EXIT=$?

    if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
        log_info "Cycle completed successfully"
    else
        log_error "Cycle failed (exit_code=${CLAUDE_EXIT})"
    fi

    rm -f "${PROMPT_FILE}" 2>/dev/null || true
    PROMPT_FILE=""
    git worktree prune 2>/dev/null || true
    safe_rm_worktree "${WORKTREE_BASE}"

    return $CLAUDE_EXIT
}

cleanup_between_cycles() {
    log_info "Cleaning up between cycles..."
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    safe_rm_worktree "${WORKTREE_BASE}"
    git branch --merged main | grep -v 'main' | grep -v '^\*' | xargs -r git branch -d 2>/dev/null || true
    log_info "Cleanup complete"
}

# Main
log_info "=== Starting discovery cycle ==="
log_info "Spawn Discovery Team"
log_info "Mode: ${MODE}"
log_info "Worktree base: ${WORKTREE_BASE}"
cd "${REPO_ROOT}"
git checkout main 2>/dev/null || true
git fetch --prune origin 2>/dev/null || true
git pull --rebase origin main 2>/dev/null || true
get_matrix_summary
echo ""

case "${MODE}" in
    --loop)
        cycle=1
        while true; do
            log_info "=== Team Cycle ${cycle} ==="
            run_team_cycle || {
                log_error "Cycle ${cycle} failed, pausing 10s..."
                sleep 10
            }
            cleanup_between_cycles
            cycle=$((cycle + 1))
            log_info "Pausing 5s before next cycle..."
            sleep 5
        done
        ;;
    *)
        run_team_cycle
        ;;
esac
