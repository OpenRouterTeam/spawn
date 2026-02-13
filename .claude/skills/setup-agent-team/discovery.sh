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

Your job: coordinate teammates to expand the spawn matrix. Use delegate mode — do NOT implement anything yourself. Only coordinate, review, and synthesize.

**CRITICAL: Your session MUST stay alive for the entire cycle.** After spawning teammates, you MUST call WaitForMessage in a loop to receive their results. Do NOT end your conversation after spawning — that orphans teammates. Spawning is the BEGINNING of your work.

## FIRST STEP: Update README Matrix (MANDATORY — do this BEFORE spawning teammates)

Before doing anything else, sync the root `README.md` matrix table with `manifest.json`. This ensures the README reflects the current state before any new work begins. Run this script, then replace the matrix table between `## Matrix` and `### How it works` in README.md. Also update the stats line near the top (`**X agents. Y clouds. Z combinations. Zero config.**`).

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

Commit and push this README update directly to main before spawning any teammates. Use commit message: `docs: Sync README matrix with manifest.json`

## Time Budget

Each cycle MUST complete within 45 minutes. This is a HARD deadline.

- At the 35-minute mark, stop spawning new work and tell all teammates to wrap up
- At the 40-minute mark, send shutdown_request to any teammate that hasn't finished
- At 45 minutes, force shutdown — the cycle is over regardless

Teammates should aim for focused, high-impact work. Do NOT exhaustively expand everything.

## No Self-Merge Rule (MANDATORY)

Teammates must NEVER merge their own PRs. This applies to ALL teammates including the team lead.

After creating a PR, every teammate MUST:
1. **Self-review**: Read the diff and add a review comment summarizing changes, tests run, and any concerns:
   `gh pr diff NUMBER --repo OpenRouterTeam/spawn`
   `gh pr review NUMBER --repo OpenRouterTeam/spawn --comment --body "Self-review by AGENT-NAME: [summary of changes, what was tested, any concerns]\n\n-- discovery/AGENT-NAME"`
2. **Label**: Add `needs-team-review` so external reviewers can find it:
   `gh pr edit NUMBER --repo OpenRouterTeam/spawn --add-label "needs-team-review"`
3. **Leave the PR open** — do NOT run `gh pr merge`

Merging is handled externally (by maintainers or a separate review cycle).

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
Research and add NEW cloud/sandbox providers. Focus on **cheap CPU compute** for running AI agents that use remote API inference (not GPU workloads):
- Container/sandbox platforms (like E2B, Modal, Fly.io — fast, developer-friendly)
- Budget VPS providers with cheap small instances ($5-20/mo range)
- Regional/niche clouds with simple APIs (OVH, Scaleway, UpCloud)
- Any provider with a REST API or CLI for provisioning + SSH or exec access

**DO NOT add GPU clouds.** Spawn agents call remote LLM APIs for inference — they need cheap CPU instances with SSH, not expensive GPU VMs.

For each candidate, verify:
- Has a public API or CLI for creating instances/containers
- Supports SSH, exec, or console access to the created environment
- Has affordable CPU instances (pay-per-hour or pay-per-second pricing)
- Is actually available (not waitlisted/invite-only)

**MANDATORY: Add new clouds to the test infrastructure.** When adding a new cloud, you MUST also update ALL of these files:

**`test/record.sh`** (fixture recording):
1. Add the cloud to `ALL_RECORDABLE_CLOUDS`
2. Add a case in `get_endpoints()` with the cloud's GET-only API endpoints
3. Add a case in `get_auth_env_var()` mapping the cloud to its auth env var
4. Add a case in `call_api()` to dispatch to the cloud's API function
5. Add a case in `has_api_error()` for the cloud's error response format
6. Add a `_live_{cloud}()` function for create/delete server fixture recording

**`test/mock.sh`** (mock test infrastructure — ALL of these):
1. **URL stripping**: Add a case in `_strip_api_base()` to recognize the cloud's API base URL (e.g., `https://api.newcloud.com/v1*`). Without this, mock curl logs `UNHANDLED_URL` warnings.
2. **Body validation**: Add a case in `_validate_body()` with the cloud's server creation endpoint and required POST body fields
3. **Cloud API assertions**: Add a case in `assert_cloud_api_calls()` with the cloud's expected API calls (SSH key fetch endpoint + server create endpoint)
4. **Environment setup**: Add a case in `setup_env_for_cloud()` with the cloud's test env vars (API token, server name, plan, region, etc.)

Without ALL of these, the new cloud will have no test coverage, body validation will be missing, and the QA cycle will skip it entirely.

### Agent Scout (spawn 1, only if justified)
Research new AI agents, BUT only add one if there's REAL community demand:

**Search these sources for buzz:**
- Search Hacker News (https://hn.algolia.com/api/v1/search?query=...) for the agent name — look for posts with 50+ points
- Search Reddit r/LocalLLaMA, r/MachineLearning, r/ChatGPT for the agent — look for posts with 100+ upvotes
- Check the agent's GitHub repo — must have 1000+ stars
- Search Twitter/X for the agent name + "AI agent"

**Only add the agent if:**
- It's installable via a single command (npm, pip, curl)
- It accepts API keys via env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY)
- It has genuine community excitement (not just a press release)
- It's NOT already in manifest.json

### Issue Responder (spawn 1)
Check the repo's GitHub issues for user requests:
- Run: `gh issue list --repo OpenRouterTeam/spawn --state open --limit 20`
- Look for issues requesting specific agents or cloud providers
- **DEDUP CHECK (MANDATORY before ANY comment):** For each issue, FIRST check existing comments:
  `gh issue view NUMBER --repo OpenRouterTeam/spawn --json comments --jq '.comments[] | "\(.author.login): \(.body[-40:])"'`
  If the issue already has a comment containing `-- discovery/issue-responder`, SKIP — you've already commented.
  Also check for similar content from other accounts. Never duplicate information.
- If a request is actionable, implement it and create a PR (self-review + label, do NOT merge)
- Comment on the issue with the PR link when done (only if no similar comment already exists)
- If a request is already implemented, close the issue with a comment (only if not already commented)
- **SIGN-OFF**: Every comment MUST end with `-- discovery/issue-responder`. This is how teammates identify their own comments for dedup.

### Gap Filler (spawn remaining)
After scouts commit new entries, pick up the newly-created "missing" matrix entries and implement them.

## CRITICAL: Team Coordination (ref: https://code.claude.com/docs/en/agent-teams)

You are using **spawn teams** (not subagents). Teammates are independent Claude Code sessions that communicate via the team messaging system. Messages from teammates are delivered AUTOMATICALLY as new user turns between your responses.

**Your session ENDS the moment you produce a response with no tool call.** You MUST include at least one tool call in every response.

### Required monitoring pattern:

After spawning all teammates, enter this loop:

```
1. Call TaskList to check task status
2. Process any teammate messages that arrived (acknowledge, update task)
3. If tasks still pending, call Bash("sleep 5") to yield, then go back to step 1
4. If 35 minutes have elapsed, send wrap-up messages to all teammates
5. Only after ALL teammates have finished, proceed to shutdown
```

**EVERY iteration MUST call TaskList.** Do NOT just loop on `sleep 5`.

### Common mistake (DO NOT DO THIS):
```
BAD:  Spawn teammates → "I've assigned the work, my job is done" → session ends
BAD:  sleep 5 → sleep 5 → sleep 5 (never calls TaskList, never processes messages!)
GOOD: TaskList → process results → sleep 5 → TaskList → process results → ... → shutdown
```

## Commit Markers (MANDATORY)

Every teammate MUST include an `Agent:` trailer in commit messages to identify the author.
Format: `Agent: <role>` as the last trailer line before Co-Authored-By.

Example:
```
feat: Add Kamatera cloud provider

Agent: cloud-scout
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

Marker values: `cloud-scout`, `agent-scout`, `issue-responder`, `gap-filler`, `team-lead`.
NEVER omit the Agent trailer. EVERY commit from a teammate must have one.

## Git Worktrees (MANDATORY for parallel work)

Multiple teammates working simultaneously MUST use git worktrees instead of switching branches in the main checkout. This prevents teammates from clobbering each other's uncommitted changes.

### Setup (Team Lead does this at cycle start)
```bash
mkdir -p WORKTREE_BASE_PLACEHOLDER
```

### Per-Teammate Worktree Pattern

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

# 6. Create PR (can be done from anywhere)
gh pr create --title "title" --body "body

-- discovery/AGENT-NAME"

# 7. Self-review and label (DO NOT merge — see No Self-Merge Rule)
gh pr diff NUMBER --repo OpenRouterTeam/spawn
gh pr review NUMBER --repo OpenRouterTeam/spawn --comment --body "Self-review by AGENT-NAME: [summary]

-- discovery/AGENT-NAME"
gh pr edit NUMBER --repo OpenRouterTeam/spawn --add-label "needs-team-review"

# 8. Clean up worktree (PR stays open for external review)
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME
```

### Why Worktrees?
- Multiple teammates work on different branches simultaneously without conflicts
- No risk of `git checkout` clobbering another teammate's uncommitted changes
- Each teammate gets a clean, isolated working directory
- The main checkout stays on `main` and is never switched away

### Rules
- NEVER use `git checkout -b` or `git switch` in the main repo when other teammates are active
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
6. Create PR: `gh pr create --title "..." --body "...\n\n-- discovery/AGENT-NAME"`
7. Self-review and label (DO NOT merge):
   `gh pr diff NUMBER --repo OpenRouterTeam/spawn`
   `gh pr review NUMBER --repo OpenRouterTeam/spawn --comment --body "Self-review by AGENT-NAME: [summary]\n\n-- discovery/AGENT-NAME"`
   `gh pr edit NUMBER --repo OpenRouterTeam/spawn --add-label "needs-team-review"`
8. **If PR cannot be created** (conflicts, etc.):
   - Comment on the PR explaining WHY
   - Close with: `gh pr close {number} --comment "Closing: {reason}\n\n-- discovery/AGENT-NAME"`
   - NEVER close a PR silently — every closed PR MUST have a comment
9. Clean up worktree: `git worktree remove WORKTREE_BASE_PLACEHOLDER/{branch-name}`

### PR Policy (MANDATORY):
Every PR must reach one of these terminal states:
- **OPEN with self-review + `needs-team-review` label** — the standard path, always preferred
- **CLOSED with comment** — only when PR is impossible (conflicts, duplicate work), with a clear explanation

### NEVER:
- Run `gh pr merge` — merging is handled externally
- Push directly to main
- Use `git checkout -b` when other teammates are active — use worktrees
- Close a PR without a comment explaining why
- Leave PRs without a self-review comment and `needs-team-review` label
- Leave branches or worktrees hanging after work is done
- Work on a stale base — always `git fetch origin main` before creating a worktree

## Lifecycle Management (MANDATORY — DO NOT EXIT EARLY)

You MUST remain active until ALL of the following are true:

1. **All tasks are completed**: Run TaskList and confirm every task has status "completed"
2. **All PRs are self-reviewed and labeled**: Run `gh pr list --repo OpenRouterTeam/spawn --state open --author @me` and confirm every PR from this cycle has a self-review comment and the `needs-team-review` label. Do NOT merge — PRs stay open for external review.
3. **All provider PRs are labeled**: Run `gh pr list --repo OpenRouterTeam/spawn --state open --json number,title,headRefName` and check for ANY open PRs related to cloud providers. For each:
   - Ensure it has a self-review comment and `needs-team-review` label
   - If not mergeable (conflicts) → close with comment: `gh pr close NUMBER --comment "Auto-closing: provider PR from interrupted cycle (unmergeable). Please reopen if still needed.\n\n-- discovery/team-lead"`
   - If mergeable → leave open with label for external review (do NOT merge)
4. **All worktrees are cleaned**: Run `git worktree list` and confirm only the main worktree exists. Run `rm -rf WORKTREE_BASE_PLACEHOLDER` and `git worktree prune`.
5. **All teammates are shut down**: Send `shutdown_request` to EVERY teammate. Wait for each to confirm. Do NOT exit while any teammate is still active.

### Shutdown Sequence (execute in this exact order):

1. Check TaskList — if any tasks are still in_progress or pending, wait and check again (poll every 30 seconds, up to 5 minutes)
2. Verify all PRs are self-reviewed and labeled: `gh pr list --repo OpenRouterTeam/spawn --state open --label "needs-team-review"` (PRs stay open — do NOT merge)
3. **Sweep for leftover provider PRs**: `gh pr list --repo OpenRouterTeam/spawn --state open --json number,title,headRefName,mergeable`
   - For each PR whose title or branch references a cloud/provider:
     - If mergeable → ensure it has `needs-team-review` label and a self-review comment (do NOT merge)
     - If not mergeable → close with `gh pr close NUMBER --comment "Auto-closing: stale provider PR (unmergeable). Please reopen if still needed.\n\n-- discovery/team-lead"`
   - Log every action taken
4. For each teammate, send a `shutdown_request` via SendMessage
5. Wait for all `shutdown_response` confirmations
6. Run final cleanup: `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER`
7. Print final summary of what was accomplished (include count of PRs merged/closed)
8. ONLY THEN may the session end

### CRITICAL: If you exit before completing this sequence, running teammates will be orphaned and the cycle will be incomplete. You MUST wait for all teammates to shut down before exiting.

## FINAL STEP: Update README Matrix Again (MANDATORY — Team Lead does this LAST)

After ALL teammates have shut down and ALL PRs are merged, the team lead MUST sync the README matrix one final time. This catches any changes made during the cycle. Use the same python script from the FIRST STEP above. Commit directly to main with: `docs: Sync README matrix with manifest.json (post-cycle)`

The cycle is NOT complete until this final README update is committed and pushed.

## Rules for ALL teammates:
- Read CLAUDE.md Shell Script Rules before writing ANY code
- OpenRouter injection is MANDATORY in every script
- `bash -n {file}` syntax-check before committing
- ALWAYS include `Agent: <role>` trailer in commit messages
- ALWAYS use worktrees — never `git checkout -b` in the main repo
- ALWAYS `git fetch origin main` before creating a worktree
- Each teammate works on DIFFERENT files
- Each unit of work gets its own worktree → branch → PR → self-review → label → cleanup worktree
- **Every PR must have a self-review comment + `needs-team-review` label, OR be closed with a comment** — no silent closes, no unlabeled PRs
- **NEVER run `gh pr merge`** — merging is handled externally
- Update manifest.json, the cloud's README.md, AND the root README.md matrix
- Clean up worktrees after every PR: `git worktree remove PATH`
- NEVER revert prior macOS/curl-bash compatibility fixes
- **SIGN-OFF**: Every comment on issues/PRs MUST end with `-- discovery/AGENT-NAME` (e.g., `-- discovery/issue-responder`, `-- discovery/cloud-scout`). This is how teammates identify their own comments for dedup across cycles.

Begin now. Your session has THREE phases — all are mandatory:
1. **Setup** — Update README, create team, spawn teammates via SendMessage
2. **Monitor** — Call WaitForMessage in a loop until ALL teammates report back. This is the longest phase. Do NOT skip it.
3. **Shutdown** — Run the full shutdown sequence, update README, then exit

If you end your conversation after phase 1, the cycle FAILS — teammates are orphaned. You MUST reach phase 3.
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
