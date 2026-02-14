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
if [[ -n "${SPAWN_ISSUE}" ]] && [[ ! "${SPAWN_ISSUE}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: SPAWN_ISSUE must be a positive integer, got: '${SPAWN_ISSUE}'" >&2
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
    CYCLE_TIMEOUT=1800  # 30 min for refactor runs
fi

LOG_FILE="${REPO_ROOT}/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] [${RUN_MODE}] $*" | tee -a "${LOG_FILE}"
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
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    # Clean up prompt and PID files
    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true
    rm -f "${CLAUDE_PID_FILE:-}" 2>/dev/null || true

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
    log "Issue: #${SPAWN_ISSUE}"
fi

# Fetch latest refs (read-only, safe for concurrent runs)
log "Fetching latest refs..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true

# Pre-cycle cleanup only in refactor mode (issue runs skip housekeeping)
if [[ "${RUN_MODE}" == "refactor" ]]; then
    # Reset main checkout to origin/main
    git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

    log "Pre-cycle cleanup: stale worktrees and branches..."
    git worktree prune 2>&1 | tee -a "${LOG_FILE}" || true
    if [[ -d "${WORKTREE_BASE}" ]]; then
        rm -rf "${WORKTREE_BASE}" 2>&1 | tee -a "${LOG_FILE}" || true
        log "Removed stale ${WORKTREE_BASE} directory"
    fi

    # Delete merged refactor-related remote branches (fix/*, refactor/*, test/*, ux/*)
    MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -v 'origin/main\|origin/HEAD' | grep -E 'origin/(fix/|refactor/|test/|ux/)' | sed 's|origin/||' | tr -d ' ') || true
    for branch in $MERGED_BRANCHES; do
        if [[ -n "$branch" ]]; then
            git push origin --delete "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted merged branch: $branch" || true
        fi
    done

    # Delete stale local refactor-related branches
    LOCAL_BRANCHES=$(git branch --list 'fix/*' --list 'refactor/*' --list 'test/*' --list 'ux/*' | tr -d ' *') || true
    for branch in $LOCAL_BRANCHES; do
        if [[ -n "$branch" ]]; then
            git branch -D "$branch" 2>&1 | tee -a "${LOG_FILE}" || true
        fi
    done

    log "Pre-cycle cleanup done."
fi

# Launch Claude Code with mode-specific prompt
log "Launching ${RUN_MODE} cycle..."

PROMPT_FILE=$(mktemp /tmp/refactor-prompt-XXXXXX.md)

if [[ "${RUN_MODE}" == "issue" ]]; then
    # --- Issue mode: lightweight 2-teammate fix ---
    cat > "${PROMPT_FILE}" << 'ISSUE_PROMPT_EOF'
You are the Team Lead for a focused issue-fix cycle on the spawn codebase.

## Target Issue

Fix GitHub issue #SPAWN_ISSUE_PLACEHOLDER.

## Context Gathering (MANDATORY)

Fetch the COMPLETE issue thread before starting:
```bash
gh issue view SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --comments
gh pr list --repo OpenRouterTeam/spawn --search "SPAWN_ISSUE_PLACEHOLDER" --json number,title,url
```
For each linked PR: `gh pr view PR_NUM --repo OpenRouterTeam/spawn --comments`

Read ALL comments — prior discussion contains decisions, rejected approaches, and scope changes.

## Time Budget

Complete within 10 minutes. At 7 min stop new work, at 9 min shutdown teammates, at 10 min force shutdown.

## Team Structure

1. **issue-fixer** (Sonnet) — Diagnose root cause, implement fix in worktree, run tests, create PR with `Fixes #SPAWN_ISSUE_PLACEHOLDER`
2. **issue-tester** (Haiku) — Review fix for correctness/edge cases, run `bun test` + `bash -n` on modified .sh files, report results

## Label Management

Track lifecycle: "pending-review" → "under-review" → "in-progress". Check labels first: `gh issue view SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --json labels --jq '.labels[].name'`
- Start: `gh issue edit SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --remove-label "pending-review" --remove-label "under-review" --add-label "in-progress"`
- After merge: `gh issue edit SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --remove-label "in-progress"`

## Workflow

1. Create team, fetch issue, transition label to "in-progress"
2. DEDUP: `gh issue view SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --json comments --jq '.comments[].author.login'` — only post acknowledgment if no automated comments exist
3. Post acknowledgment (if needed): `gh issue comment SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --body "Thanks for flagging this! Looking into it now.\n\n-- refactor/issue-fixer"`
4. Create worktree: `git worktree add WORKTREE_BASE_PLACEHOLDER -b fix/issue-SPAWN_ISSUE_PLACEHOLDER origin/main`
5. Spawn issue-fixer + issue-tester
6. When fix is ready: push, create PR with `Fixes #SPAWN_ISSUE_PLACEHOLDER` in body, post update comment linking PR
7. Do NOT close the issue — `Fixes #SPAWN_ISSUE_PLACEHOLDER` auto-closes on merge
8. Clean up: `git worktree remove WORKTREE_BASE_PLACEHOLDER`, shutdown teammates

## Commit Markers

Every commit: `Agent: issue-fixer` + `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`

## Safety

- Run tests after every change
- If fix is not straightforward (>10 min), comment on issue explaining complexity and exit

Begin now. Fix issue #SPAWN_ISSUE_PLACEHOLDER.
ISSUE_PROMPT_EOF

    # Substitute placeholders with validated values (safe — no shell expansion)
    sed -i "s|SPAWN_ISSUE_PLACEHOLDER|${SPAWN_ISSUE}|g" "${PROMPT_FILE}"
    sed -i "s|WORKTREE_BASE_PLACEHOLDER|${WORKTREE_BASE}|g" "${PROMPT_FILE}"

else
    # --- Refactor mode: full 6-teammate team ---
    cat > "${PROMPT_FILE}" << 'PROMPT_EOF'
You are the Team Lead for the spawn continuous refactoring service.

Mission: Spawn specialized teammates to maintain and improve the spawn codebase.

## Time Budget

Complete within 15 minutes. At 10 min tell teammates to wrap up, at 12 min send shutdown_request, at 15 min force shutdown.

Teammates: aim for ONE high-impact PR each, not many small ones.

## Separation of Concerns

Refactor team **creates PRs** — security team **reviews and merges** them.
- Teammates: research deeply, create PR with clear description, leave it open
- MAY `gh pr merge` ONLY if PR is already approved (reviewDecision=APPROVED)
- NEVER `gh pr review --approve` or `--request-changes` — that's the security team's job

## Team Structure

1. **security-auditor** (Sonnet) — Scan .sh for injection/path traversal/credential leaks, .ts for XSS/prototype pollution. Fix HIGH/CRITICAL only, document medium/low.
2. **ux-engineer** (Sonnet) — Test e2e flows, improve error messages, fix UX papercuts, verify README examples.
3. **complexity-hunter** (Haiku) — Find functions >50 lines (bash) / >80 lines (ts). Pick top 2-3, ONE PR. Run tests after refactoring.
4. **test-engineer** (Haiku) — ONE test PR max. Add missing tests, verify shellcheck, run `bun test`, fix failures.

5. **pr-maintainer** (Sonnet)
   Role: Keep PRs healthy and mergeable. Do NOT review/approve/merge — security team handles that.

   First: `gh pr list --repo OpenRouterTeam/spawn --state open --json number,title,headRefName,updatedAt,mergeable,reviewDecision`

   For EACH PR, fetch full context:
   ```
   gh pr view NUMBER --repo OpenRouterTeam/spawn --comments
   gh api repos/OpenRouterTeam/spawn/pulls/NUMBER/comments --jq '.[] | "\(.user.login): \(.body)"'
   ```
   Read ALL comments — prior discussion contains decisions, rejected approaches, and scope changes.

   **Comment-based triage** — Close if comments indicate superseded/duplicate/abandoned:
   `gh pr close NUMBER --repo OpenRouterTeam/spawn --delete-branch --comment "Closing: [reason].\n\n-- refactor/pr-maintainer"`

   For remaining PRs:
   - **Merge conflicts**: rebase in worktree, force-push. If unresolvable, comment.
   - **Review changes requested**: read comments, address fixes in worktree, push, comment summary.
   - **Failing checks**: investigate, fix if trivial, push. If non-trivial, comment.
   - **Approved + mergeable**: rebase, merge: `gh pr merge NUMBER --repo OpenRouterTeam/spawn --squash --delete-branch`
   - **Not yet reviewed**: leave alone — security team handles review.

   NEVER review or approve PRs. But if already approved, DO merge.
   Run again at cycle end to catch new PRs. GOAL: approved PRs merged, conflicts resolved, feedback addressed.

6. **community-coordinator** (Sonnet)
   First: `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt`

   For EACH issue, fetch full context:
   ```
   gh issue view NUMBER --repo OpenRouterTeam/spawn --comments
   gh pr list --repo OpenRouterTeam/spawn --search "NUMBER" --json number,title,url
   ```
   Read ALL comments — prior discussion contains decisions, rejected approaches, and scope changes.

   **Labels**: "pending-review" → "under-review" → "in-progress". Check before modifying: `gh issue view NUMBER --json labels --jq '.labels[].name'`
   **DEDUP**: Check `--json comments --jq '.comments[] | "\(.author.login): \(.body[-30:])"'` — skip if `-- refactor/community-coordinator` already exists.

   - Acknowledge issues briefly and casually (only if not already acknowledged)
   - Categorize (bug/feature/question) and delegate to relevant teammate
   - Post interim updates as teammates report findings (only if no similar update exists)
   - Link PRs: `gh issue comment NUMBER --body "Fix in PR_URL. [explanation].\n\n-- refactor/community-coordinator"`
   - Do NOT close issues — PRs with `Fixes #NUMBER` auto-close on merge
   - Re-scan every 5 min + final sweep. Every issue must be engaged by end of cycle.
   - **SIGN-OFF**: Every comment MUST end with `-- refactor/community-coordinator`

## Issue Fix Workflow

1. Community-coordinator: dedup check → label "under-review" → acknowledge → delegate → label "in-progress"
2. Fixing teammate: `git worktree add WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER -b fix/issue-NUMBER origin/main` → fix → commit (with Agent: marker) → push → `gh pr create --body "Fixes #NUMBER\n\n-- refactor/AGENT-NAME"` → clean up worktree
3. Community-coordinator: post PR link on issue. Do NOT close issue — auto-closes on merge.
4. NEVER close a PR without a comment. NEVER close an issue manually.

## Commit Markers

Every commit: `Agent: <agent-name>` trailer + `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`
Values: security-auditor, ux-engineer, complexity-hunter, test-engineer, pr-maintainer, community-coordinator, team-lead.

## Git Worktrees (MANDATORY)

Every teammate uses worktrees — never `git checkout -b` in the main repo.

```bash
git worktree add WORKTREE_BASE_PLACEHOLDER/BRANCH -b BRANCH origin/main
cd WORKTREE_BASE_PLACEHOLDER/BRANCH
# ... work, commit, push ...
gh pr create --title "title" --body "body\n\n-- refactor/AGENT-NAME"
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH
```

Setup: `mkdir -p WORKTREE_BASE_PLACEHOLDER`. Cleanup: `git worktree prune` at cycle end.

## Team Coordination

You use **spawn teams**. Messages arrive AUTOMATICALLY between turns. **Session ENDS when you produce a response with no tool call.**

After spawning, loop: `TaskList` → process messages → `Bash("sleep 5")` → repeat. EVERY iteration MUST call TaskList.

## Lifecycle Management

Stay active until: all tasks completed, all PRs created, all issues engaged+labeled, all worktrees cleaned, all teammates shut down.

Shutdown: poll TaskList → verify PRs → verify issues engaged → `shutdown_request` to each teammate → wait for confirmations → `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER` → checkpoint → summary → exit.

CRITICAL: Exiting early orphans teammates. Wait for ALL shutdown confirmations.

## Safety

- NEVER close a PR — rebase, fix, or comment instead
- Checkpoint before risky changes: `sprite-env checkpoint create --comment 'Description'`
- Run tests after every change. If 3 consecutive failures, pause and investigate.
- **SIGN-OFF**: Every comment MUST end with `-- refactor/AGENT-NAME`

Begin now. Spawn the team and start working. DO NOT EXIT until all teammates are shut down.
PROMPT_EOF

    # Substitute WORKTREE_BASE_PLACEHOLDER with actual worktree path
    sed -i "s|WORKTREE_BASE_PLACEHOLDER|${WORKTREE_BASE}|g" "${PROMPT_FILE}"
fi

# Add grace period: issue=5min, refactor=10min beyond the prompt timeout
if [[ "${RUN_MODE}" == "issue" ]]; then
    HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))   # 15 + 5 = 20 min
else
    HARD_TIMEOUT=$((CYCLE_TIMEOUT + 600))   # 30 + 10 = 40 min
fi

log "Hard timeout: ${HARD_TIMEOUT}s"

# NOTE: VM keep-alive is handled by the trigger server streaming output back
# to the GitHub Actions runner. The long-lived HTTP response keeps Sprite alive.

# Activity watchdog: kill claude if no output for IDLE_TIMEOUT seconds.
# This catches hung API calls (pre-flight check hangs, network issues) much
# faster than the hard timeout. The next cron trigger starts a fresh cycle.
# 10 min is long enough for legitimate teammate work (teammates send messages every
# few minutes) but short enough to catch truly hung API calls.
IDLE_TIMEOUT=600  # 10 minutes of silence = hung

# Run claude in background so we can monitor output activity.
# Capture claude's actual PID via wrapper — $! gives tee's PID, not claude's.
CLAUDE_PID_FILE=$(mktemp /tmp/claude-pid-XXXXXX)
( claude -p "$(cat "${PROMPT_FILE}")" --output-format stream-json --verbose &
  echo $! > "${CLAUDE_PID_FILE}"
  wait
) 2>&1 | tee -a "${LOG_FILE}" &
PIPE_PID=$!
sleep 2  # let claude start and write its PID

# Kill claude and its full process tree reliably
kill_claude() {
    local cpid
    cpid=$(cat "${CLAUDE_PID_FILE}" 2>/dev/null)
    if [[ -n "${cpid}" ]] && kill -0 "${cpid}" 2>/dev/null; then
        log "Killing claude (pid=${cpid}) and its process tree"
        pkill -TERM -P "${cpid}" 2>/dev/null || true
        kill -TERM "${cpid}" 2>/dev/null || true
        sleep 5
        pkill -KILL -P "${cpid}" 2>/dev/null || true
        kill -KILL "${cpid}" 2>/dev/null || true
    fi
    kill "${PIPE_PID}" 2>/dev/null || true
}

# Watchdog loop: check log file growth and detect session completion
LAST_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
LOG_START_SIZE="${LAST_SIZE}"  # bytes written before this cycle — skip old content
IDLE_SECONDS=0
WALL_START=$(date +%s)
SESSION_ENDED=false

while kill -0 "${PIPE_PID}" 2>/dev/null; do
    sleep 10
    CURR_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
    WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

    # Check if the stream-json "result" event has been emitted (session complete).
    # Only check content written SINCE this cycle started (skip old log entries).
    # After this, claude hangs waiting for teammate subprocesses — kill immediately.
    if [[ "${SESSION_ENDED}" = false ]] && tail -c +"$((LOG_START_SIZE + 1))" "${LOG_FILE}" 2>/dev/null | grep -q '"type":"result"'; then
        SESSION_ENDED=true
        log "Session ended (result event detected) — waiting 30s for cleanup then killing"
        sleep 30
        kill_claude
        break
    fi

    if [[ "${CURR_SIZE}" -eq "${LAST_SIZE}" ]]; then
        IDLE_SECONDS=$((IDLE_SECONDS + 10))
        if [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
            log "Watchdog: no output for ${IDLE_SECONDS}s — killing hung process"
            kill_claude
            break
        fi
    else
        IDLE_SECONDS=0
        LAST_SIZE="${CURR_SIZE}"
    fi

    # Hard wall-clock timeout as final safety net
    if [[ "${WALL_ELAPSED}" -ge "${HARD_TIMEOUT}" ]]; then
        log "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
        kill_claude
        break
    fi
done

wait "${PIPE_PID}" 2>/dev/null
CLAUDE_EXIT=$?

if [[ "${CLAUDE_EXIT}" -eq 0 ]] || [[ "${SESSION_ENDED}" = true ]]; then
    log "Cycle completed successfully"

    # Direct commit to main only in refactor mode
    if [[ "${RUN_MODE}" == "refactor" ]]; then
        if [[ -n "$(git status --porcelain)" ]]; then
            log "Committing changes from cycle..."
            git add -A
            git commit -m "refactor: Automated improvements

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" 2>&1 | tee -a "${LOG_FILE}" || true

            # Push to main
            git push origin main 2>&1 | tee -a "${LOG_FILE}" || true
        fi
    fi

    # Create checkpoint
    log "Creating checkpoint..."
    sprite-env checkpoint create --comment "${RUN_MODE} cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
elif [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
    log "Cycle killed by activity watchdog (no output for ${IDLE_TIMEOUT}s)"

    # Still checkpoint partial work
    log "Creating checkpoint for partial work..."
    sprite-env checkpoint create --comment "${RUN_MODE} cycle hung (watchdog kill)" 2>&1 | tee -a "${LOG_FILE}" || true
elif [[ "${CLAUDE_EXIT}" -eq 124 ]]; then
    log "Cycle timed out after ${HARD_TIMEOUT}s — killed by hard timeout"

    log "Creating checkpoint for partial work..."
    sprite-env checkpoint create --comment "${RUN_MODE} cycle timed out (partial)" 2>&1 | tee -a "${LOG_FILE}" || true
else
    log "Cycle failed (exit_code=${CLAUDE_EXIT})"
fi

# Note: cleanup (worktree prune, prompt file removal, final log) handled by trap
