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

# --- Cleanup trap ---
cleanup() {
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1
    local exit_code=$?
    log_info "Running cleanup (exit_code=${exit_code})..."
    cd "${REPO_ROOT}" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true
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

if ! command -v python3 &>/dev/null; then
    log_error "python3 is required for manifest parsing"
    exit 1
fi

if [[ ! -f "${MANIFEST}" ]]; then
    log_error "manifest.json not found at ${MANIFEST}"
    exit 1
fi

export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

get_matrix_summary() {
    python3 - "${MANIFEST}" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1]))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
gaps = [k for k, v in m.get('matrix', {}).items() if v == 'missing']
impl = sum(1 for v in m['matrix'].values() if v == 'implemented')
total = len(agents) * len(clouds)
print(f'Matrix: {len(agents)} agents x {len(clouds)} clouds = {impl}/{total} implemented')
if gaps:
    print(f'Gaps ({len(gaps)}): {", ".join(gaps[:10])}')
else:
    print('Matrix is full')
print(f'Agents: {", ".join(agents)}')
print(f'Clouds: {", ".join(clouds)}')
PYEOF
}

# Cleanup stale worktrees, branches, and related state
_cleanup_stale_artifacts() {
    log_info "Pre-cycle cleanup..."
    git worktree prune 2>/dev/null || true
    if [[ -d "${WORKTREE_BASE}" ]]; then
        rm -rf "${WORKTREE_BASE}" 2>/dev/null || true
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
    local prompt_template="${SCRIPT_DIR}/discovery-team-prompt.txt"
    if [[ ! -f "$prompt_template" ]]; then
        log_error "discovery-team-prompt.txt not found at $prompt_template"
        exit 1
    fi
    cat "$prompt_template" > "${output_file}"

    local summary
    summary=$(get_matrix_summary)
    python3 - "${output_file}" "${summary}" <<'PYEOF'
import sys
path, replacement = sys.argv[1], sys.argv[2]
content = open(path).read()
open(path, 'w').write(content.replace('MATRIX_SUMMARY_PLACEHOLDER', replacement))
PYEOF

    sed -i "s|WORKTREE_BASE_PLACEHOLDER|${WORKTREE_BASE}|g" "${output_file}"
}

# Kill claude process and its full process tree
_kill_claude_process() {
    local pipe_pid="$1"
    local claude_pid_file="$2"
    local cpid
    cpid=$(cat "${claude_pid_file}" 2>/dev/null)
    if [[ -n "${cpid}" ]] && kill -0 "${cpid}" 2>/dev/null; then
        log_info "Killing claude (pid=${cpid}) and its process tree"
        pkill -TERM -P "${cpid}" 2>/dev/null || true
        kill -TERM "${cpid}" 2>/dev/null || true
        sleep 5
        pkill -KILL -P "${cpid}" 2>/dev/null || true
        kill -KILL "${cpid}" 2>/dev/null || true
    fi
    kill "${pipe_pid}" 2>/dev/null || true
}

# Monitor watchdog for claude process
_run_watchdog_loop() {
    local pipe_pid="$1"
    local idle_timeout="$2"
    local hard_timeout="$3"
    local claude_pid_file="$4"
    local log_start_size="$5"

    local LAST_SIZE
    LAST_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
    local IDLE_SECONDS=0
    local WALL_START
    WALL_START=$(date +%s)
    local SESSION_ENDED=false

    while kill -0 "${pipe_pid}" 2>/dev/null; do
        sleep 10
        local CURR_SIZE
        CURR_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
        local WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

        # Check if the stream-json "result" event has been emitted (team lead done).
        # In team-based workflows, the team lead's result fires after spawning
        # teammates — the actual work is still running as child processes.
        if [[ "${SESSION_ENDED}" = false ]] && tail -c +"$((log_start_size + 1))" "${LOG_FILE}" 2>/dev/null | grep -q '"type":"result"'; then
            SESSION_ENDED=true
            log_info "Team lead session ended — waiting for teammate processes to complete"
        fi

        # After team lead finishes, monitor child processes instead of log output.
        if [[ "${SESSION_ENDED}" = true ]]; then
            local LEAD_PID
            LEAD_PID=$(cat "${claude_pid_file}" 2>/dev/null || true)
            if [[ -n "${LEAD_PID}" ]] && pgrep -P "${LEAD_PID}" >/dev/null 2>&1; then
                IDLE_SECONDS=0
            else
                log_info "All teammate processes completed — shutting down"
                sleep 10
                _kill_claude_process "${pipe_pid}" "${claude_pid_file}"
                break
            fi
        fi

        if [[ "${CURR_SIZE}" -eq "${LAST_SIZE}" ]]; then
            IDLE_SECONDS=$((IDLE_SECONDS + 10))
            if [[ "${IDLE_SECONDS}" -ge "${idle_timeout}" ]]; then
                log_warn "Watchdog: no output for ${IDLE_SECONDS}s — killing hung process"
                _kill_claude_process "${pipe_pid}" "${claude_pid_file}"
                break
            fi
        else
            IDLE_SECONDS=0
            LAST_SIZE="${CURR_SIZE}"
        fi

        if [[ "${WALL_ELAPSED}" -ge "${hard_timeout}" ]]; then
            log_warn "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
            _kill_claude_process "${pipe_pid}" "${claude_pid_file}"
            break
        fi
    done

    wait "${pipe_pid}" 2>/dev/null
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

    local IDLE_TIMEOUT=600  # 10 minutes of silence = hung
    local HARD_TIMEOUT=3600 # 60 min wall-clock safety net

    log_info "Idle timeout: ${IDLE_TIMEOUT}s, Hard timeout: ${HARD_TIMEOUT}s"

    local CLAUDE_PID_FILE
    CLAUDE_PID_FILE=$(mktemp /tmp/claude-pid-XXXXXX)

    ( claude -p "$(cat "${PROMPT_FILE}")" --dangerously-skip-permissions --model sonnet \
        --output-format stream-json --verbose &
      echo $! > "${CLAUDE_PID_FILE}"
      wait
    ) 2>&1 | tee -a "${LOG_FILE}" &

    local PIPE_PID=$!
    sleep 2

    local LOG_START_SIZE
    LOG_START_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)

    _run_watchdog_loop "${PIPE_PID}" "${IDLE_TIMEOUT}" "${HARD_TIMEOUT}" "${CLAUDE_PID_FILE}" "${LOG_START_SIZE}"
    local CLAUDE_EXIT=$?

    if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
        log_info "Cycle completed successfully"
    else
        log_error "Cycle failed (exit_code=${CLAUDE_EXIT})"
    fi

    rm -f "${CLAUDE_PID_FILE}" 2>/dev/null || true
    rm -f "${PROMPT_FILE}" 2>/dev/null || true
    PROMPT_FILE=""
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    return $CLAUDE_EXIT
}

cleanup_between_cycles() {
    log_info "Cleaning up between cycles..."
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true
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
