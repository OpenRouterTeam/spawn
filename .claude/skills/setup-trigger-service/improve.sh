#!/bin/bash
# Continuous improvement loop for spawn using Claude Code Agent Teams
#
# Discovery priorities:
#   1. Clouds/sandboxes > agents (bias toward new compute targets)
#   2. Agents must have real community buzz (HN, Reddit, GitHub stars)
#   3. Check repo issues for user requests
#   4. Fill matrix gaps from prior discovery
#
# Usage:
#   ./improve.sh                  # one team cycle
#   ./improve.sh --loop           # continuous cycles
#   ./improve.sh --single         # single-agent mode (no teams)

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MANIFEST="${REPO_ROOT}/manifest.json"
MODE="${1:-once}"

# --- Lifecycle config (mirrors refactor.sh patterns) ---
WORKTREE_BASE="/tmp/spawn-worktrees/improve"
TEAM_NAME="spawn-improve"
CYCLE_TIMEOUT=3600   # 60 min for team cycles
SINGLE_TIMEOUT=1800  # 30 min for single-agent cycles
LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { printf "${GREEN}[improve]${NC} %s\n" "$1"; echo "[$(date +'%Y-%m-%d %H:%M:%S')] [improve] $1" >> "${LOG_FILE}"; }
log_warn()  { printf "${YELLOW}[improve]${NC} %s\n" "$1"; echo "[$(date +'%Y-%m-%d %H:%M:%S')] [improve] WARN: $1" >> "${LOG_FILE}"; }
log_error() { printf "${RED}[improve]${NC} %s\n" "$1"; echo "[$(date +'%Y-%m-%d %H:%M:%S')] [improve] ERROR: $1" >> "${LOG_FILE}"; }

# --- Cleanup trap (from refactor.sh) ---
cleanup() {
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
You are the lead of the spawn improvement team. Read CLAUDE.md and manifest.json first.

Current state:
PROMPT_EOF
    echo "${summary}"
    cat <<'PROMPT_EOF'

Your job: coordinate teammates to expand the spawn matrix. Use delegate mode — do NOT implement anything yourself. Only coordinate, review, and synthesize.

## Time Budget

Each cycle MUST complete within 45 minutes. This is a HARD deadline.

- At the 35-minute mark, stop spawning new work and tell all agents to wrap up
- At the 40-minute mark, send shutdown_request to any agent that hasn't finished
- At 45 minutes, force shutdown — the cycle is over regardless

Agents should aim for focused, high-impact work. Do NOT exhaustively expand everything.

## Priority Order

1. **Fill gaps first** — if manifest.json has "missing" entries, fill them before discovering
2. **Clouds/sandboxes over agents** — we want MORE places to run, not more agents
3. **Agents only if community demands it** — see discovery rules below
4. **Check repo issues** — users may have requested specific agents or clouds

## Phase 1: Fill Gaps

If there are "missing" entries in the matrix, spawn one teammate per gap (up to 5). Each implements one {cloud}/{agent}.sh by reading the cloud's lib/common.sh + the agent's script on another cloud.

## Phase 2: Discovery (when matrix is full)

Spawn these teammates in parallel:

### Cloud Scout (PRIORITY — spawn 2 of these)
Research and add NEW cloud/sandbox providers. Focus on:
- Container/sandbox platforms (like E2B, Modal, Fly.io — fast, developer-friendly)
- GPU clouds (CoreWeave, RunPod, Vast.ai, Together AI)
- Regional/niche clouds with simple APIs (OVH, Scaleway, UpCloud)
- Any provider with a REST API or CLI for provisioning + SSH or exec access

For each candidate, verify:
- Has a public API or CLI for creating instances/containers
- Supports SSH, exec, or console access to the created environment
- Has pay-per-hour or pay-per-second pricing
- Is actually available (not waitlisted/invite-only)

### Agent Scout (spawn 1, only if justified)
Research new AI coding agents, BUT only add one if there's REAL community demand:

**Search these sources for buzz:**
- Search Hacker News (https://hn.algolia.com/api/v1/search?query=...) for the agent name — look for posts with 50+ points
- Search Reddit r/LocalLLaMA, r/MachineLearning, r/ChatGPT for the agent — look for posts with 100+ upvotes
- Check the agent's GitHub repo — must have 1000+ stars
- Search Twitter/X for the agent name + "coding agent" or "AI agent"

**Only add the agent if:**
- It's installable via a single command (npm, pip, curl)
- It accepts API keys via env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY)
- It has genuine community excitement (not just a press release)
- It's NOT already in manifest.json

### Issue Responder (spawn 1)
Check the repo's GitHub issues for user requests:
- Run: `gh issue list --repo OpenRouterTeam/spawn --state open --limit 20`
- Look for issues requesting specific agents or cloud providers
- If a request is actionable, implement it
- Comment on the issue with the PR link when done
- If a request is already implemented, close the issue with a comment

### Branch Cleaner (spawn 1)
Clean up stale remote branches before and after the cycle:
- List all remote branches: `git branch -r --format='%(refname:short) %(committerdate:unix)'`
- For each branch (excluding main):
  * Check if there's an open PR: `gh pr list --head BRANCH --state open --json number,title`
  * If open PR and branch is stale (last commit >4 hours ago):
    - Mergeable → merge with `gh pr merge NUMBER --squash --delete-branch`
    - Conflicts/failing → close with `gh pr close NUMBER --comment "Auto-closing: stale branch. Please reopen if still needed."`
  * If no open PR and stale >4 hours → delete with `git push origin --delete BRANCH`
  * If fresh (<4 hours) → leave alone
- Run again at end of cycle to catch branches created during the cycle

### Gap Filler (spawn remaining)
After scouts commit new entries, pick up the newly-created "missing" matrix entries and implement them.

## Commit Markers (MANDATORY)

Every teammate MUST include an `Agent:` trailer in commit messages to identify the author.
Format: `Agent: <role>` as the last trailer line before Co-Authored-By.

Example:
```
feat: Add RunPod cloud provider

Agent: cloud-scout
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

Marker values: `cloud-scout`, `agent-scout`, `issue-responder`, `branch-cleaner`, `gap-filler`, `team-lead`.
NEVER omit the Agent trailer. EVERY commit from a teammate must have one.

## Git Worktrees (MANDATORY for parallel work)

Multiple agents working simultaneously MUST use git worktrees instead of switching branches in the main checkout. This prevents agents from clobbering each other's uncommitted changes.

### Setup (Team Lead does this at cycle start)
```bash
mkdir -p WORKTREE_BASE_PLACEHOLDER
```

### Per-Agent Worktree Pattern

CRITICAL: Always fetch latest main before creating a worktree.

```bash
# 1. Fetch latest main (from the main checkout)
git fetch origin main

# 2. Create a worktree for the branch off latest origin/main
git worktree add WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME -b BRANCH-NAME origin/main

# 3. Do all work inside the worktree
cd WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME
# ... make changes, run bash -n, run tests ...

# 4. Commit with Agent marker
git add FILES
git commit -m "description

Agent: role-name
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

# 5. Push
git push -u origin BRANCH-NAME

# 6. Create and merge PR (can be done from anywhere)
gh pr create --title "title" --body "body"
gh pr merge NUMBER --squash --delete-branch

# 7. Clean up worktree
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME
```

### Why Worktrees?
- Multiple agents work on different branches simultaneously without conflicts
- No risk of `git checkout` clobbering another agent's uncommitted changes
- Each agent gets a clean, isolated working directory
- The main checkout stays on `main` and is never switched away

### Rules
- NEVER use `git checkout -b` or `git switch` in the main repo when other agents are active
- ALWAYS `git fetch origin main` before `git worktree add` to ensure the branch starts from latest main
- ALWAYS clean up worktrees after PR is merged: `git worktree remove PATH`
- At end of cycle, team lead runs: `git worktree prune`

## Git Workflow (CRITICAL)

Every teammate MUST follow this workflow using worktrees. NO exceptions.

### For each unit of work:
1. Fetch latest: `git fetch origin main`
2. Create worktree: `git worktree add WORKTREE_BASE_PLACEHOLDER/{branch-name} -b {branch-name} origin/main`
3. Work inside worktree: `cd WORKTREE_BASE_PLACEHOLDER/{branch-name}`
4. Do the work, commit (with Agent: marker)
5. Push: `git push -u origin {branch-name}`
6. Create PR: `gh pr create --title "..." --body "..."`
7. Try to merge: `gh pr merge --squash --delete-branch`
8. **If merge fails** (conflicts, CI, etc.):
   - Comment on the PR explaining WHY it cannot be merged
   - Close with: `gh pr close {number} --comment "Closing: {reason}"`
   - Acceptable reasons: merge conflict with a concurrent PR, superseded by another PR, implementation found to be incorrect after review
   - NEVER close a PR silently — every closed PR MUST have a comment
9. Clean up worktree: `git worktree remove WORKTREE_BASE_PLACEHOLDER/{branch-name}`

### PR Policy (MANDATORY):
Every PR must reach one of these terminal states:
- **MERGED** — the happy path, always preferred
- **CLOSED with comment** — only when merge is impossible, with a clear explanation

### NEVER:
- Push directly to main
- Use `git checkout -b` when other agents are active — use worktrees
- Close a PR without a comment explaining why
- Leave PRs open/abandoned — resolve them in the same cycle
- Leave branches or worktrees hanging after merge
- Work on a stale base — always `git fetch origin main` before creating a worktree

## Lifecycle Management (MANDATORY — DO NOT EXIT EARLY)

You MUST remain active until ALL of the following are true:

1. **All tasks are completed**: Run TaskList and confirm every task has status "completed"
2. **All PRs are resolved**: Run `gh pr list --repo OpenRouterTeam/spawn --state open --author @me` and confirm zero open PRs from this cycle. Every PR must be either merged or closed with a comment.
3. **All worktrees are cleaned**: Run `git worktree list` and confirm only the main worktree exists. Run `rm -rf WORKTREE_BASE_PLACEHOLDER` and `git worktree prune`.
4. **All teammates are shut down**: Send `shutdown_request` to EVERY teammate. Wait for each to confirm. Do NOT exit while any teammate is still active.

### Shutdown Sequence (execute in this exact order):

1. Check TaskList — if any tasks are still in_progress or pending, wait and check again (poll every 30 seconds, up to 5 minutes)
2. Verify all PRs merged or closed: `gh pr list --repo OpenRouterTeam/spawn --state open`
3. For each teammate, send a `shutdown_request` via SendMessage
4. Wait for all `shutdown_response` confirmations
5. Run final cleanup: `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER`
6. Print final summary of what was accomplished
7. ONLY THEN may the session end

### CRITICAL: If you exit before completing this sequence, running agents will be orphaned and the cycle will be incomplete. You MUST wait for all teammates to shut down before exiting.

## After EVERY change (MANDATORY):

After each PR is merged, one teammate MUST update the root `README.md` matrix table to reflect the current state. The matrix table in README.md must always match manifest.json. Run this to regenerate it:

```bash
python3 -c "
import json
m = json.load(open('manifest.json'))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
agent_meta = m['agents']
cloud_meta = m['clouds']
# Header
cols = ' | '.join(f'[{cloud_meta[c][\"name\"]}]({c}/)' for c in clouds)
print(f'| | {cols} |')
print(f'|---|{\"|---\" * len(clouds)}|')
# Rows
for a in agents:
    name = agent_meta[a]['name']
    url = agent_meta[a].get('url','')
    cells = ' | '.join('✓' if m['matrix'].get(f'{c}/{a}') == 'implemented' else ' ' for c in clouds)
    print(f'| [**{name}**]({url}) | {cells} |')
"
```

Copy the output and replace the matrix table between `## Matrix` and `## Development` in README.md. Include this update in the same PR or as a follow-up PR immediately after.

## Rules for ALL teammates:
- Read CLAUDE.md Shell Script Rules before writing ANY code
- OpenRouter injection is MANDATORY in every script
- `bash -n {file}` syntax-check before committing
- ALWAYS include `Agent: <role>` trailer in commit messages
- ALWAYS use worktrees — never `git checkout -b` in the main repo
- ALWAYS `git fetch origin main` before creating a worktree
- Each teammate works on DIFFERENT files
- Each unit of work gets its own worktree → branch → PR → merge → cleanup worktree
- **Every PR must be merged OR closed with a comment** — no silent closes, no abandoned PRs
- Update manifest.json, the cloud's README.md, AND the root README.md matrix
- Clean up worktrees after every PR: `git worktree remove PATH`
- NEVER revert prior macOS/curl-bash compatibility fixes

Begin now. Spawn the team and start working. DO NOT EXIT until all teammates are shut down and all cleanup is complete per the Lifecycle Management section above.
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

Your priority: find a NEW cloud/sandbox provider to add. Search for container platforms,
GPU clouds, or regional providers with REST APIs. Create lib/common.sh, add to manifest,
implement 2-3 agents, add "missing" entries for the rest.

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

    # Ensure we're on main and up to date, prune stale remote-tracking refs
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    # Prune stale worktrees
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    # Delete merged remote branches (not main)
    local merged_branches
    merged_branches=$(git branch -r --merged origin/main | grep -v 'main' | grep 'origin/' | sed 's|origin/||' | tr -d ' ')
    for branch in $merged_branches; do
        if [[ -n "$branch" && "$branch" != "main" ]]; then
            git push origin --delete "$branch" 2>/dev/null && log_info "Deleted merged branch: $branch" || true
        fi
    done

    # Delete local branches that are merged
    git branch --merged main | grep -v 'main' | grep -v '^\*' | xargs -r git branch -d 2>/dev/null || true

    log_info "Cleanup complete"
}

run_team_cycle() {
    # Always start fresh from latest main, prune stale remote-tracking refs
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git fetch --prune origin 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    # Set up worktree directory for parallel agent work
    mkdir -p "${WORKTREE_BASE}"

    # Write prompt to temp file (from refactor.sh pattern)
    PROMPT_FILE=$(mktemp /tmp/improve-prompt-XXXXXX.md)
    build_team_prompt > "${PROMPT_FILE}"

    # Substitute WORKTREE_BASE_PLACEHOLDER with actual worktree path
    sed -i "s|WORKTREE_BASE_PLACEHOLDER|${WORKTREE_BASE}|g" "${PROMPT_FILE}"

    log_info "Launching agent team..."
    log_info "Worktree base: ${WORKTREE_BASE}"
    log_info "Cycle timeout: ${CYCLE_TIMEOUT}s"
    echo ""

    # Add grace period: 15 min beyond the cycle timeout (from refactor.sh)
    local HARD_TIMEOUT=$((CYCLE_TIMEOUT + 900))
    log_info "Hard timeout: ${HARD_TIMEOUT}s"

    # Run Claude with the prompt file, enforcing a hard timeout
    local CLAUDE_EXIT=0
    timeout --signal=TERM --kill-after=60 "${HARD_TIMEOUT}" \
        claude -p "$(cat "${PROMPT_FILE}")" --dangerously-skip-permissions --model sonnet \
        2>&1 | tee -a "${LOG_FILE}" || CLAUDE_EXIT=$?

    if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
        log_info "Cycle completed successfully"

        # Create checkpoint for successful cycle
        log_info "Creating checkpoint..."
        sprite-env checkpoint create --comment "improve cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
    elif [[ "${CLAUDE_EXIT}" -eq 124 ]]; then
        log_warn "Cycle timed out after ${HARD_TIMEOUT}s — killed by hard timeout"

        # Still create checkpoint for any partial work that was merged
        log_info "Creating checkpoint for partial work..."
        sprite-env checkpoint create --comment "improve cycle timed out (partial)" 2>&1 | tee -a "${LOG_FILE}" || true
    else
        log_error "Cycle failed (exit_code=${CLAUDE_EXIT})"
    fi

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

    PROMPT_FILE=$(mktemp /tmp/improve-prompt-XXXXXX.md)
    build_single_prompt > "${PROMPT_FILE}"

    log_info "Launching single agent..."
    log_info "Cycle timeout: ${SINGLE_TIMEOUT}s"
    echo ""

    local HARD_TIMEOUT=$((SINGLE_TIMEOUT + 300))
    log_info "Hard timeout: ${HARD_TIMEOUT}s"

    local CLAUDE_EXIT=0
    timeout --signal=TERM --kill-after=60 "${HARD_TIMEOUT}" \
        claude --print -p "$(cat "${PROMPT_FILE}")" --model sonnet \
        2>&1 | tee -a "${LOG_FILE}" || CLAUDE_EXIT=$?

    if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
        log_info "Single cycle completed successfully"
        sprite-env checkpoint create --comment "improve single cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
    elif [[ "${CLAUDE_EXIT}" -eq 124 ]]; then
        log_warn "Single cycle timed out after ${HARD_TIMEOUT}s"
        sprite-env checkpoint create --comment "improve single cycle timed out (partial)" 2>&1 | tee -a "${LOG_FILE}" || true
    else
        log_error "Single cycle failed (exit_code=${CLAUDE_EXIT})"
    fi

    rm -f "${PROMPT_FILE}" 2>/dev/null || true
    PROMPT_FILE=""

    return $CLAUDE_EXIT
}

# Main
log_info "=== Starting improve cycle ==="
log_info "Spawn Improvement System"
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
