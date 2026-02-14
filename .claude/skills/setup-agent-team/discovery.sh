#!/bin/bash
# Continuous discovery loop for spawn using Claude Code spawn teams
#
# Discovery priorities:
#   1. Clouds/sandboxes > agents (bias toward new compute targets)
#   2. Agents must have real community buzz (HN, Reddit, GitHub stars)
#   3. Check repo issues for user requests
#   4. Fill matrix gaps from prior discovery
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

# --- Lifecycle config (mirrors refactor.sh patterns) ---
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

# --- Cleanup trap (from refactor.sh) ---
cleanup() {
    # Guard against re-entry (SIGTERM trap calls exit, which fires EXIT trap again)
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1

    local exit_code=$?
    log_info "Running cleanup (exit_code=${exit_code})..."

    cd "${REPO_ROOT}" 2>/dev/null || true

    # Prune worktrees and clean up only OUR worktree base
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    # Clean up prompt file
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
    python3 -c "
import json
m = json.load(open('${MANIFEST}'))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
gaps = [k for k, v in m.get('matrix', {}).items() if v == 'missing']
impl = sum(1 for v in m['matrix'].values() if v == 'implemented')
total = len(agents) * len(clouds)
print(f'Matrix: {len(agents)} agents x {len(clouds)} clouds = {impl}/{total} implemented')
if gaps:
    print(f'Gaps ({len(gaps)}): {\", \".join(gaps[:10])}')
else:
    print('Matrix is full — ready for discovery')
print(f'Agents: {\", \".join(agents)}')
print(f'Clouds: {\", \".join(clouds)}')
"
}

count_gaps() {
    python3 -c "
import json
m = json.load(open('${MANIFEST}'))
print(sum(1 for v in m.get('matrix', {}).values() if v == 'missing'))
"
}

build_team_prompt() {
    local summary
    summary=$(get_matrix_summary)

    cat <<'PROMPT_EOF'
You are the lead of the spawn discovery team. Read CLAUDE.md and manifest.json first.

Current state:
PROMPT_EOF
    echo "${summary}"
    cat <<'PROMPT_EOF'

Your job: coordinate teammates to expand the spawn matrix. Delegate only — do NOT implement anything yourself.

**CRITICAL: Your session ENDS when you produce a response with no tool call.** You MUST include at least one tool call in every response. Spawning teammates is the BEGINNING of your work, not the end.

## FIRST STEP: Update README Matrix (MANDATORY — before spawning)

Sync the root `README.md` matrix table with `manifest.json`. Run:

```bash
python3 -c "
import json
m = json.load(open('manifest.json'))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
impl = sum(1 for v in m['matrix'].values() if v == 'implemented')
print(f'Stats: {len(agents)} agents. {len(clouds)} clouds. {impl} combinations.')
cols = ' | '.join(f'[{m[\"clouds\"][c][\"name\"]}]({c}/)' for c in clouds)
print(f'| | {cols} |')
print(f'|---|' + '|'.join(['---' for _ in clouds]) + '|')
for a in agents:
    name = m['agents'][a]['name']
    url = m['agents'][a].get('url','')
    cells = ' | '.join('✓' if m['matrix'].get(f'{c}/{a}') == 'implemented' else ' ' for c in clouds)
    print(f'| [**{name}**]({url}) | {cells} |')
"
```

Update README.md matrix + stats line, commit directly to main: `docs: Sync README matrix with manifest.json`

## Time Budget

Complete within 45 minutes. At 35 min tell teammates to wrap up, at 40 min shutdown, at 45 min force shutdown.

## No Self-Merge Rule

Teammates NEVER merge their own PRs. After creating a PR:
1. Self-review: `gh pr review NUMBER --repo OpenRouterTeam/spawn --comment --body "Self-review by AGENT-NAME: [summary]\n\n-- discovery/AGENT-NAME"`
2. Label: `gh pr edit NUMBER --repo OpenRouterTeam/spawn --add-label "needs-team-review"`
3. Leave open — merging is handled externally.

## Priority Order

1. Fill matrix gaps first
2. Clouds/sandboxes over agents
3. Agents only with real community demand
4. Check repo issues for user requests

## Phase 1: Fill Gaps

If "missing" entries exist, spawn one teammate per gap (up to 5). Each implements {cloud}/{agent}.sh from the cloud's lib/common.sh + agent's script on another cloud.

## Phase 2: Discovery (when matrix is full)

### Cloud Scout (spawn 2, PRIORITY)
Research NEW cloud/sandbox providers. Focus on **cheap CPU compute** (NOT GPU):
- Container/sandbox platforms, budget VPS ($5-20/mo), regional clouds with simple APIs
- Must have: public API/CLI, SSH/exec access, affordable pay-per-hour pricing, actually available

**MANDATORY test infrastructure**: When adding a cloud, also update ALL of these:

**`test/record.sh`** (fixture recording):
1. Add to `ALL_RECORDABLE_CLOUDS`
2. Add case in `get_endpoints()` with GET-only API endpoints
3. Add case in `get_auth_env_var()` mapping cloud to auth env var
4. Add case in `call_api()` to dispatch to cloud's API function
5. Add case in `has_api_error()` for error response format
6. Add `_live_{cloud}()` function for create/delete fixture recording

**`test/mock.sh`** (ALL of these):
1. `_strip_api_base()`: URL-stripping case for cloud's API base URL
2. `_validate_body()`: body validation case with server creation endpoint + required fields
3. `assert_cloud_api_calls()`: expected API calls (SSH key fetch + server create)
4. `setup_env_for_cloud()`: test env vars (API token, server name, plan, region)

### Agent Scout (spawn 1, only if justified)
Only add agents with REAL community demand (2+ of: 1000+ GitHub stars, 50+ HN points, 100+ Reddit upvotes, user request in issues). Must be single-command installable, accept API keys via env vars, work with OpenRouter.

### Issue Responder (spawn 1)
`gh issue list --repo OpenRouterTeam/spawn --state open --limit 20`

For each issue, fetch the COMPLETE thread:
```bash
gh issue view NUMBER --repo OpenRouterTeam/spawn --comments
gh pr list --repo OpenRouterTeam/spawn --search "NUMBER" --json number,title,url
```
For each linked PR: `gh pr view PR_NUM --repo OpenRouterTeam/spawn --comments`

Read ALL comments — prior discussion contains decisions, rejected approaches, and scope changes.

**DEDUP**: Check `--json comments --jq '.comments[] | "\(.author.login): \(.body[-40:])"'` — skip if `-- discovery/issue-responder` already exists.
If actionable, implement and create PR (self-review + label, do NOT merge). If already implemented, close with comment.
**SIGN-OFF**: Every comment MUST end with `-- discovery/issue-responder`.

### Gap Filler (spawn remaining)
Pick up newly-created "missing" matrix entries after scouts commit.

## Commit Markers

Every commit: `Agent: <role>` trailer + `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`
Values: cloud-scout, agent-scout, issue-responder, gap-filler, team-lead.

## Git Worktrees (MANDATORY)

Every teammate uses worktrees — never `git checkout -b` in the main repo.

```bash
git fetch origin main
git worktree add WORKTREE_BASE_PLACEHOLDER/BRANCH -b BRANCH origin/main
cd WORKTREE_BASE_PLACEHOLDER/BRANCH
# ... work, commit (with Agent: marker), push ...
gh pr create --title "title" --body "body\n\n-- discovery/AGENT-NAME"
# Self-review + label (do NOT merge):
gh pr review NUMBER --comment --body "Self-review: [summary]\n\n-- discovery/AGENT-NAME"
gh pr edit NUMBER --add-label "needs-team-review"
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH
```

**PR Policy**: Every PR must be either OPEN (with self-review + `needs-team-review` label) or CLOSED (with comment via `gh pr close NUMBER --delete-branch --comment "reason"`). NEVER merge, push to main, or close silently.

## Team Coordination

You use **spawn teams**. Messages arrive AUTOMATICALLY. After spawning, loop: `TaskList` → process messages → `Bash("sleep 5")` → repeat. EVERY iteration MUST call TaskList.

## Lifecycle Management

Stay active until: all tasks completed, all PRs self-reviewed+labeled, all worktrees cleaned, all teammates shut down.

Shutdown: poll TaskList → verify PRs labeled → sweep leftover provider PRs (close unmergeable with `--delete-branch` + comment, label mergeable) → shutdown_request to each teammate → wait for confirmations → `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER` → summary → exit.

CRITICAL: Exiting early orphans teammates. Wait for ALL shutdown confirmations.

## FINAL STEP: Update README Matrix Again (MANDATORY — Team Lead does LAST)

After all teammates shut down, sync README matrix one final time. Commit: `docs: Sync README matrix with manifest.json (post-cycle)`

## Rules for ALL teammates

- Read CLAUDE.md Shell Script Rules before writing code
- OpenRouter injection is MANDATORY
- `bash -n` before committing
- Use worktrees, `git fetch origin main` before each worktree
- Each teammate works on DIFFERENT files
- Every PR: self-review + `needs-team-review` label, OR closed with comment
- NEVER `gh pr merge` — merging is handled externally
- Update manifest.json, cloud README.md, AND root README.md
- Clean up worktrees after every PR
- **SIGN-OFF**: Every comment MUST end with `-- discovery/AGENT-NAME`

Begin now. Three mandatory phases:
1. **Setup** — Update README, create team, spawn teammates
2. **Monitor** — TaskList loop until ALL teammates report back (longest phase)
3. **Shutdown** — Full shutdown sequence, final README update, exit

If you end after phase 1, the cycle FAILS.
PROMPT_EOF
}

build_single_prompt() {
    local gap
    gap=$(python3 -c "
import json
m = json.load(open('${MANIFEST}'))
for key, status in m.get('matrix', {}).items():
    if status == 'missing':
        print(key)
        break
")

    if [[ -n "${gap}" ]]; then
        local cloud="${gap%%/*}"
        local agent="${gap##*/}"
        cat <<EOF
Read CLAUDE.md and manifest.json. Implement "${cloud}/${agent}.sh":
1. Read ${cloud}/lib/common.sh for cloud primitives
2. Read an existing ${agent}.sh on another cloud for the install pattern
3. Write ${cloud}/${agent}.sh combining the two
4. Update manifest.json to mark "${cloud}/${agent}" as "implemented"
5. Update the cloud's README.md
6. bash -n syntax check
7. Commit
OpenRouter injection is mandatory. Follow CLAUDE.md Shell Script Rules.
EOF
    else
        cat <<'EOF'
Read CLAUDE.md and manifest.json. The matrix is full.

Your priority: find a NEW cloud/sandbox provider to add. Search for cheap CPU compute
providers — container platforms, budget VPS providers, or regional clouds with simple
REST APIs. We need affordable instances for running agents that use remote API inference, NOT GPU clouds.
Create lib/common.sh, add to manifest, implement 2-3 agents, add "missing" entries for the rest.

MANDATORY: When adding a new cloud, also update the test infrastructure:
1. test/record.sh — add to ALL_RECORDABLE_CLOUDS, get_endpoints(), get_auth_env_var(), call_api(), has_api_error(), and add a _live_{cloud}() function
2. test/mock.sh — add ALL of these:
   - _strip_api_base(): URL-stripping case for the cloud's API base URL
   - _validate_body(): body validation case with server creation endpoint + required fields
   - assert_cloud_api_calls(): expected API calls (SSH key fetch + server create)
   - setup_env_for_cloud(): test env vars (API token, server name, plan, region)

Only add a new AGENT if you find one with real community buzz:
- 1000+ GitHub stars
- 50+ point Hacker News posts (search https://hn.algolia.com/api/v1/search?query=AGENT)
- Active Reddit discussion in r/LocalLLaMA or r/MachineLearning

Also check `gh issue list --repo OpenRouterTeam/spawn --state open` for user requests.

Follow CLAUDE.md Shell Script Rules. Commit when done.
EOF
    fi
}

cleanup_between_cycles() {
    log_info "Cleaning up between cycles..."

    # Ensure we're on main and up to date
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    # Prune stale worktrees
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    # Delete local branches that are merged
    git branch --merged main | grep -v 'main' | grep -v '^\*' | xargs -r git branch -d 2>/dev/null || true

    # Note: branch pruning and PR management is handled by the security team
    log_info "Cleanup complete"
}

run_team_cycle() {
    # Always start fresh from latest main, prune stale remote-tracking refs
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    # --- Pre-cycle cleanup: stale worktrees and branches ---
    log_info "Pre-cycle cleanup..."
    git worktree prune 2>/dev/null || true
    if [[ -d "${WORKTREE_BASE}" ]]; then
        rm -rf "${WORKTREE_BASE}" 2>/dev/null || true
        log_info "Removed stale ${WORKTREE_BASE} directory"
    fi

    # Delete merged discovery-related remote branches
    # Discovery teammates create branches like: add-*, impl-*, gap-filler-*, {cloud}-{agent}
    MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -v 'origin/main\|origin/HEAD' | grep -E 'origin/(add-|impl-|gap-filler-)' | sed 's|origin/||' | tr -d ' ') || true
    for branch in $MERGED_BRANCHES; do
        if [[ -n "$branch" ]]; then
            git push origin --delete "$branch" 2>&1 && log_info "Deleted merged branch: $branch" || true
        fi
    done

    # Delete stale local discovery-related branches
    LOCAL_BRANCHES=$(git branch --list 'add-*' --list 'impl-*' --list 'gap-filler-*' | tr -d ' *') || true
    for branch in $LOCAL_BRANCHES; do
        if [[ -n "$branch" ]]; then
            git branch -D "$branch" 2>/dev/null || true
        fi
    done

    log_info "Pre-cycle cleanup done."

    # Set up worktree directory for parallel teammate work
    mkdir -p "${WORKTREE_BASE}"

    # Write prompt to temp file (from refactor.sh pattern)
    PROMPT_FILE=$(mktemp /tmp/discovery-prompt-XXXXXX.md)
    build_team_prompt > "${PROMPT_FILE}"

    # Substitute WORKTREE_BASE_PLACEHOLDER with actual worktree path
    sed -i "s|WORKTREE_BASE_PLACEHOLDER|${WORKTREE_BASE}|g" "${PROMPT_FILE}"

    log_info "Launching spawn team..."
    log_info "Worktree base: ${WORKTREE_BASE}"
    echo ""

    # Activity watchdog: kill claude if no output for IDLE_TIMEOUT seconds.
    # This catches hung API calls (pre-flight check hangs, network issues) much
    # faster than the trigger server's RUN_TIMEOUT_MS. The next cron trigger
    # starts a fresh cycle. 10 min is long enough for legitimate teammate work
    # (teammates send messages every few minutes) but short enough to catch hangs.
    local IDLE_TIMEOUT=600  # 10 minutes of silence = hung
    local HARD_TIMEOUT=3600 # 60 min wall-clock safety net

    log_info "Idle timeout: ${IDLE_TIMEOUT}s, Hard timeout: ${HARD_TIMEOUT}s"

    # Run claude in background so we can monitor output activity.
    # Capture claude's actual PID via wrapper — $! gives tee's PID, not claude's.
    local CLAUDE_PID_FILE
    CLAUDE_PID_FILE=$(mktemp /tmp/claude-pid-XXXXXX)
    ( claude -p "$(cat "${PROMPT_FILE}")" --dangerously-skip-permissions --model sonnet \
        --output-format stream-json --verbose &
      echo $! > "${CLAUDE_PID_FILE}"
      wait
    ) 2>&1 | tee -a "${LOG_FILE}" &
    local PIPE_PID=$!
    sleep 2  # let claude start and write its PID

    # Kill claude and its full process tree reliably
    kill_claude() {
        local cpid
        cpid=$(cat "${CLAUDE_PID_FILE}" 2>/dev/null)
        if [[ -n "${cpid}" ]] && kill -0 "${cpid}" 2>/dev/null; then
            log_info "Killing claude (pid=${cpid}) and its process tree"
            pkill -TERM -P "${cpid}" 2>/dev/null || true
            kill -TERM "${cpid}" 2>/dev/null || true
            sleep 5
            pkill -KILL -P "${cpid}" 2>/dev/null || true
            kill -KILL "${cpid}" 2>/dev/null || true
        fi
        kill "${PIPE_PID}" 2>/dev/null || true
    }

    # Watchdog loop: check log file growth and detect session completion
    local LAST_SIZE
    LAST_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
    local LOG_START_SIZE="${LAST_SIZE}"  # bytes before this cycle — skip old content
    local IDLE_SECONDS=0
    local WALL_START
    WALL_START=$(date +%s)
    local SESSION_ENDED=false

    while kill -0 "${PIPE_PID}" 2>/dev/null; do
        sleep 10
        local CURR_SIZE
        CURR_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
        local WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

        # Check if the stream-json "result" event has been emitted (session complete).
        # Only check content written SINCE this cycle started (skip old log entries).
        # After this, claude hangs waiting for teammate subprocesses — kill immediately.
        if [[ "${SESSION_ENDED}" = false ]] && tail -c +"$((LOG_START_SIZE + 1))" "${LOG_FILE}" 2>/dev/null | grep -q '"type":"result"'; then
            SESSION_ENDED=true
            log_info "Session ended (result event detected) — waiting 30s for cleanup then killing"
            sleep 30
            kill_claude
            break
        fi

        if [[ "${CURR_SIZE}" -eq "${LAST_SIZE}" ]]; then
            IDLE_SECONDS=$((IDLE_SECONDS + 10))
            if [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
                log_warn "Watchdog: no output for ${IDLE_SECONDS}s — killing hung process"
                kill_claude
                break
            fi
        else
            IDLE_SECONDS=0
            LAST_SIZE="${CURR_SIZE}"
        fi

        # Hard wall-clock timeout as final safety net
        if [[ "${WALL_ELAPSED}" -ge "${HARD_TIMEOUT}" ]]; then
            log_warn "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
            kill_claude
            break
        fi
    done

    wait "${PIPE_PID}" 2>/dev/null
    local CLAUDE_EXIT=$?

    if [[ "${CLAUDE_EXIT}" -eq 0 ]] || [[ "${SESSION_ENDED}" = true ]]; then
        log_info "Cycle completed successfully"
        log_info "Creating checkpoint..."
        sprite-env checkpoint create --comment "discovery cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
    elif [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
        log_warn "Cycle killed by activity watchdog (no output for ${IDLE_TIMEOUT}s)"
        log_info "Creating checkpoint for partial work..."
        sprite-env checkpoint create --comment "discovery cycle hung (watchdog kill)" 2>&1 | tee -a "${LOG_FILE}" || true
    else
        log_error "Cycle failed (exit_code=${CLAUDE_EXIT})"
    fi

    # Clean up PID file
    rm -f "${CLAUDE_PID_FILE}" 2>/dev/null || true

    # Clean up prompt file
    rm -f "${PROMPT_FILE}" 2>/dev/null || true
    PROMPT_FILE=""

    # Clean up worktrees after cycle
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    return $CLAUDE_EXIT
}

run_single_cycle() {
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    PROMPT_FILE=$(mktemp /tmp/discovery-prompt-XXXXXX.md)
    build_single_prompt > "${PROMPT_FILE}"

    log_info "Launching single agent..."
    echo ""

    local IDLE_TIMEOUT=600  # 10 minutes of silence = hung
    local HARD_TIMEOUT=2100 # 35 min wall-clock for single agent

    log_info "Idle timeout: ${IDLE_TIMEOUT}s, Hard timeout: ${HARD_TIMEOUT}s"

    claude --print -p "$(cat "${PROMPT_FILE}")" --model sonnet \
        2>&1 | tee -a "${LOG_FILE}" &
    local PIPE_PID=$!

    local LAST_SIZE
    LAST_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
    local IDLE_SECONDS=0
    local WALL_START
    WALL_START=$(date +%s)

    while kill -0 "${PIPE_PID}" 2>/dev/null; do
        sleep 10
        local CURR_SIZE
        CURR_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
        local WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

        if [[ "${CURR_SIZE}" -eq "${LAST_SIZE}" ]]; then
            IDLE_SECONDS=$((IDLE_SECONDS + 10))
            if [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
                log_warn "Watchdog: no output for ${IDLE_SECONDS}s — killing hung process"
                kill -- -"${PIPE_PID}" 2>/dev/null || kill "${PIPE_PID}" 2>/dev/null || true
                pkill -P "${PIPE_PID}" 2>/dev/null || true
                break
            fi
        else
            IDLE_SECONDS=0
            LAST_SIZE="${CURR_SIZE}"
        fi

        if [[ "${WALL_ELAPSED}" -ge "${HARD_TIMEOUT}" ]]; then
            log_warn "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
            kill -- -"${PIPE_PID}" 2>/dev/null || kill "${PIPE_PID}" 2>/dev/null || true
            pkill -P "${PIPE_PID}" 2>/dev/null || true
            break
        fi
    done

    wait "${PIPE_PID}" 2>/dev/null
    local CLAUDE_EXIT=$?

    if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
        log_info "Single cycle completed successfully"
        sprite-env checkpoint create --comment "discovery single cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
    elif [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
        log_warn "Single cycle killed by activity watchdog (no output for ${IDLE_TIMEOUT}s)"
        sprite-env checkpoint create --comment "discovery single cycle hung (watchdog kill)" 2>&1 | tee -a "${LOG_FILE}" || true
    else
        log_error "Single cycle failed (exit_code=${CLAUDE_EXIT})"
    fi

    rm -f "${PROMPT_FILE}" 2>/dev/null || true
    PROMPT_FILE=""

    return $CLAUDE_EXIT
}

# Main
log_info "=== Starting discovery cycle ==="
log_info "Spawn Discovery System"
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
            # Clean up merged branches and sync main between cycles
            cleanup_between_cycles
            cycle=$((cycle + 1))
            log_info "Pausing 5s before next cycle..."
            sleep 5
        done
        ;;
    --single)
        run_single_cycle
        ;;
    *)
        run_team_cycle
        ;;
esac
