#!/bin/bash
set -eo pipefail

# Refactoring Team Service — Single Cycle (Dual-Mode)
# Triggered by trigger-server.ts via GitHub Actions
#
# RUN_MODE=issue   — lightweight 2-agent fix for a specific GitHub issue (15 min)
# RUN_MODE=refactor — full 6-agent team for codebase maintenance (30 min)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

# --- Run mode detection ---
SPAWN_ISSUE="${SPAWN_ISSUE:-}"
SPAWN_REASON="${SPAWN_REASON:-manual}"

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

LOG_FILE="/home/sprite/spawn/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] [${RUN_MODE}] $*" | tee -a "${LOG_FILE}"
}

# Cleanup function — runs on normal exit, SIGTERM, and SIGINT
cleanup() {
    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."

    # Stop keep-alive loop
    stop_keepalive

    cd "${REPO_ROOT}" 2>/dev/null || true

    # Prune worktrees and clean up only OUR worktree base
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    # Clean up prompt file
    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true

    log "=== Cycle Done (exit_code=${exit_code}) ==="
    exit $exit_code
}

trap cleanup EXIT SIGTERM SIGINT

# --- Keep-alive: ping the Sprite's PUBLIC URL to prevent VM pause ---
# Sprite only counts inbound HTTP requests through its proxy as "active."
# Localhost requests (curl http://localhost:8080/health) bypass the proxy
# entirely and do NOT prevent the VM from pausing. We must hit the public
# URL so the request routes through the Sprite proxy infrastructure.
KEEPALIVE_PID=""
SPRITE_PUBLIC_URL=""
start_keepalive() {
    # Resolve the Sprite's public URL from sprite-env info
    SPRITE_PUBLIC_URL=$(sprite-env info 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['sprite_url'])" 2>/dev/null) || SPRITE_PUBLIC_URL=""

    if [[ -z "${SPRITE_PUBLIC_URL}" ]]; then
        log "WARNING: Could not resolve Sprite public URL — keep-alive will use localhost (may not prevent pause)"
        SPRITE_PUBLIC_URL="http://localhost:8080"
    else
        log "Keep-alive will ping: ${SPRITE_PUBLIC_URL}/health"
    fi

    (
        while true; do
            # Ping via public URL (routes through Sprite proxy, counts as active HTTP)
            curl -sf "${SPRITE_PUBLIC_URL}/health" >/dev/null 2>&1 || true
            sleep 30
        done
    ) &
    KEEPALIVE_PID=$!
}
stop_keepalive() {
    if [[ -n "${KEEPALIVE_PID}" ]]; then
        kill "${KEEPALIVE_PID}" 2>/dev/null || true
        wait "${KEEPALIVE_PID}" 2>/dev/null || true
        KEEPALIVE_PID=""
    fi
}

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

    log "Pre-cycle cleanup: stale worktrees..."
    git worktree prune 2>&1 | tee -a "${LOG_FILE}" || true
    if [[ -d "${WORKTREE_BASE}" ]]; then
        rm -rf "${WORKTREE_BASE}" 2>&1 | tee -a "${LOG_FILE}" || true
        log "Removed stale ${WORKTREE_BASE} directory"
    fi

    log "Pre-cycle cleanup: merged remote branches..."
    MERGED_BRANCHES=$(git branch -r --merged origin/main | grep -v 'main' | grep 'origin/' | sed 's|origin/||' | tr -d ' ') || true
    for branch in $MERGED_BRANCHES; do
        if [[ -n "$branch" && "$branch" != "main" ]]; then
            git push origin --delete "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted merged branch: $branch" || true
        fi
    done

    log "Pre-cycle cleanup: stale open PRs..."
    STALE_PRS=$(gh pr list --repo OpenRouterTeam/spawn --state open --json number,updatedAt --jq '.[] | select(.updatedAt < (now - 7200 | todate)) | .number' 2>/dev/null) || true
    for pr_num in $STALE_PRS; do
        if [[ -n "$pr_num" ]]; then
            log "Found stale PR #${pr_num}, checking if mergeable..."
            PR_MERGEABLE=$(gh pr view "$pr_num" --repo OpenRouterTeam/spawn --json mergeable --jq '.mergeable' 2>/dev/null) || PR_MERGEABLE="UNKNOWN"
            if [[ "$PR_MERGEABLE" == "MERGEABLE" ]]; then
                log "Merging stale PR #${pr_num}..."
                gh pr merge "$pr_num" --repo OpenRouterTeam/spawn --squash --delete-branch 2>&1 | tee -a "${LOG_FILE}" || true
            else
                log "Closing unmergeable stale PR #${pr_num}..."
                gh pr close "$pr_num" --repo OpenRouterTeam/spawn --comment "Auto-closing: stale PR from a previous interrupted cycle. Please reopen if still needed." 2>&1 | tee -a "${LOG_FILE}" || true
            fi
        fi
    done
fi

# Launch Claude Code with mode-specific prompt
log "Launching ${RUN_MODE} cycle..."

PROMPT_FILE=$(mktemp /tmp/refactor-prompt-XXXXXX.md)

if [[ "${RUN_MODE}" == "issue" ]]; then
    # --- Issue mode: lightweight 2-agent fix ---
    cat > "${PROMPT_FILE}" << ISSUE_PROMPT_EOF
You are the Team Lead for a focused issue-fix cycle on the spawn codebase.

## Target Issue

Fix GitHub issue #${SPAWN_ISSUE}.

First, fetch the issue details:
\`\`\`bash
gh issue view ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn
\`\`\`

## Time Budget

This cycle MUST complete within 10 minutes. This is a HARD deadline.

- At the 7-minute mark, stop new work and wrap up
- At the 9-minute mark, send shutdown_request to all agents
- At 10 minutes, force shutdown

## Team Structure

Create these teammates:

1. **issue-fixer** (Sonnet)
   - Diagnose the root cause of issue #${SPAWN_ISSUE}
   - Implement the fix in an isolated worktree
   - Run tests to verify the fix
   - Create a PR with \`Fixes #${SPAWN_ISSUE}\` in the body
   - Merge the PR immediately

2. **issue-tester** (Haiku)
   - Review the fix for correctness and edge cases
   - Run \`bun test\` to verify no regressions
   - Run \`bash -n\` on any modified .sh files
   - Report test results to the team lead

## Workflow

1. Create the team with TeamCreate
2. Fetch issue details: \`gh issue view ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn\`
3. DEDUP CHECK: Check if issue already has comments from automated accounts:
   \`gh issue view ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --json comments --jq '.comments[].author.login'\`
   Only post acknowledgment if no automated comments exist.
4. Post acknowledgment comment on the issue (if not already acknowledged):
   \`gh issue comment ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --body "Thanks for flagging this! Looking into it now."\`
5. Create worktree: \`git worktree add ${WORKTREE_BASE} -b fix/issue-${SPAWN_ISSUE} origin/main\`
6. Spawn issue-fixer to work in \`${WORKTREE_BASE}\`
7. Spawn issue-tester to review and test
8. When fix is ready:
   - Push: \`git push -u origin fix/issue-${SPAWN_ISSUE}\`
   - PR: \`gh pr create --title "fix: Description" --body "Fixes #${SPAWN_ISSUE}"\`
   - Merge: \`gh pr merge --squash --delete-branch\`
9. Post resolution comment on the issue with PR link
10. Close the issue: \`gh issue close ${SPAWN_ISSUE}\`
11. Clean up worktree: \`git worktree remove ${WORKTREE_BASE}\`
12. Shutdown all teammates and exit

## Commit Markers (MANDATORY)

Every commit MUST include:
\`\`\`
Agent: issue-fixer
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
\`\`\`

## Safety Rules

- Run tests after every change
- Never break existing functionality
- If fix is not straightforward (>10 min), post a comment on the issue explaining the complexity and close the cycle

Begin now. Fix issue #${SPAWN_ISSUE}.
ISSUE_PROMPT_EOF

else
    # --- Refactor mode: full 6-agent team ---
    cat > "${PROMPT_FILE}" << 'PROMPT_EOF'
You are the Team Lead for the spawn continuous refactoring service.

Your mission: Spawn a team of specialized agents to maintain and improve the spawn codebase autonomously.

## Time Budget

Each cycle MUST complete within 15 minutes. This is a HARD deadline.

- At cycle start, note the current time
- At the 10-minute mark, stop spawning new work and tell all agents to wrap up
- At the 12-minute mark, send shutdown_request to any agent that hasn't finished
- At 15 minutes, force shutdown — the cycle is over regardless

Agents should aim for ONE high-impact PR each, not many small ones.
Complexity-hunter: pick the top 1-2 worst functions, fix them, PR, done. Do NOT exhaustively refactor everything.
Test-engineer: add ONE focused test file, PR, done. Do NOT aim for 100% coverage.
Security-auditor: scan for HIGH/CRITICAL only. Document medium/low, don't fix them.

## Team Structure

Create these teammates:

1. **security-auditor** (Sonnet)
   - Scan all .sh scripts for command injection, path traversal, credential leaks
   - Check TypeScript code for XSS, prototype pollution, unsafe eval
   - Review OpenRouter API key handling
   - Fix HIGH/CRITICAL only. Document medium/low for future cycles (see #104, #105, #106 for examples).
   - Fix vulnerabilities immediately

2. **ux-engineer** (Sonnet)
   - Test end-to-end user flows (spawn cli -> cloud -> agent launch)
   - Improve error messages (make them actionable and clear)
   - Fix UX papercuts (confusing prompts, unclear help text, broken workflows)
   - Verify all usage examples in READMEs work

3. **complexity-hunter** (Haiku)
   - Find bash functions >50 lines or TypeScript functions >80 lines
   - Pick the top 2-3 functions only. ONE PR with all fixes. Do not keep finding more.
   - Reduce cyclomatic complexity without breaking features
   - Extract repeated code patterns into shared utilities
   - Run tests after each refactoring to verify no regressions

4. **test-engineer** (Haiku)
   - ONE test PR maximum. Focus on the most critical gaps.
   - Add missing tests for new features
   - Verify all bash scripts with shellcheck
   - Run 'bun test' and fix failures
   - Add integration tests for critical paths

5. **branch-cleaner** (Haiku)
   - FIRST TASK: List all remote branches: git branch -r --format='%(refname:short) %(committerdate:unix)'
   - For each remote branch (excluding main):
     * Check if there's an open PR: gh pr list --head BRANCH --state open --json number,title
     * If open PR exists and branch is stale (last commit >4 hours ago):
       - If PR is mergeable: merge it with gh pr merge NUMBER --squash --delete-branch
       - If PR has conflicts or failing checks: close it with gh pr close NUMBER --comment "Auto-closing: stale branch with unresolvable conflicts. Please reopen if still needed."
     * If no open PR and branch is stale (>4 hours old): delete it with git push origin --delete BRANCH
     * If branch is fresh (<4 hours): leave it alone (may be actively worked on)
   - After cleanup, report summary: how many branches merged, closed, deleted, left alone
   - Run this check AGAIN at the end of the cycle to catch branches created during the cycle
   - GOAL: Zero stale branches left on the remote after each cycle.

6. **community-coordinator** (Sonnet)
   - FIRST TASK: Run `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt`
   - DEDUP CHECK (MANDATORY before ANY comment): For each issue, FIRST check existing comments:
     `gh issue view NUMBER --repo OpenRouterTeam/spawn --json comments --jq '.comments[].author.login'`
     If the issue already has a comment from your bot account (check for "la14-1" or any automated commenter), SKIP posting an acknowledgment — the issue has already been engaged.
     Only post an acknowledgment if the issue has ZERO comments from automated accounts.
   - For issues that need acknowledgment, post a brief, casual comment thanking them for flagging it (e.g. "Thanks for flagging this!" or "Appreciate the report!") — keep it short and natural, not corporate
   - Before posting ANY comment (acknowledgment, interim update, or resolution), ALWAYS check existing comments first:
     `gh issue view NUMBER --repo OpenRouterTeam/spawn --json comments --jq '.comments[-1].body'`
     If the last comment already contains similar content (e.g., already has a "Thanks for flagging" or already has a resolution with a PR link), do NOT post again. Never duplicate information.
   - Categorize each issue (bug, feature request, question, already-fixed)
   - For bugs: message the relevant teammate to investigate
     * Security-related → message security-auditor
     * UX/error messages → message ux-engineer
     * Test failures → message test-engineer
     * Code quality → message complexity-hunter
   - Post interim updates on issues as teammates report findings (only if no similar update exists):
     gh issue comment NUMBER --body "Update: We've identified the root cause — [summary]. Working on a fix now."
   - When a fix PR is merged, post the final resolution (only if no resolution comment exists yet):
     gh issue comment NUMBER --body "This has been fixed in PR_URL. [Brief explanation of what was changed and why]. The fix is live on main — please try updating and let us know if you still see the issue."
   - Then close: gh issue close NUMBER
   - For feature requests: comment acknowledging the request, label as enhancement, and close with a note pointing to discussions
   - For questions: answer directly in a comment, then close
   - GOAL: Every issue reporter should feel heard and informed. No cold trails.
   - PERIODIC RE-SCAN: After your initial scan AND after every 5 minutes, re-run
     `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt`
     to catch issues filed DURING the cycle. Apply the same dedup + engagement workflow.
   - FINAL SWEEP (MANDATORY before shutdown): Do one last issue scan. Any new issues must be
     acknowledged before the cycle ends. If there's no time to fix them, at minimum post an
     acknowledgment comment so the reporter knows we've seen it.
   - EVERY open issue must be engaged by end of cycle. No dangling issues.
   - NEVER post duplicate comments. One acknowledgment per issue. One resolution per issue.

## Issue Fix Workflow (CRITICAL follow exactly)

When fixing a bug reported in a GitHub issue:

1. Community-coordinator checks for existing comments (dedup) before posting acknowledgment
2. Community-coordinator posts acknowledgment comment on the issue (only if not already acknowledged)
3. Community-coordinator messages the relevant teammate to investigate
4. Create a worktree for the fix:
   git worktree add WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER -b fix/issue-NUMBER origin/main
5. Work inside the worktree: cd WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER
6. Implement the fix and commit (include Agent: marker)
7. Community-coordinator posts interim update on the issue with root cause summary (only if no similar update exists)
8. Push the branch: git push -u origin fix/issue-NUMBER
9. Create a PR that references the issue:
   gh pr create --title "Fix: description" --body "Fixes #NUMBER"
10. Merge the PR immediately: gh pr merge --squash --delete-branch
11. Clean up: git worktree remove WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER
12. Community-coordinator posts final resolution comment with PR link and explanation (only if no resolution exists)
13. Close the issue: gh issue close NUMBER

NEVER leave an issue open after the fix is merged. NEVER leave a PR unmerged.
If a PR cannot be merged (conflicts, superseded, etc.), close it WITH a comment explaining why.
NEVER close a PR silently — every closed PR MUST have a comment.
The full cycle is: acknowledge → investigate → worktree → fix → update → PR (references issue) → merge PR → cleanup → resolve & close issue.

## Commit Markers (MANDATORY)

Every agent MUST include a marker trailer in their commit messages to identify which agent authored the change.
Format: `Agent: <agent-name>` as the last trailer line before Co-Authored-By.

Example commit message:
```
fix: Sanitize port input in OAuth server

Agent: security-auditor
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

Agent marker values:
- `Agent: security-auditor`
- `Agent: ux-engineer`
- `Agent: complexity-hunter`
- `Agent: test-engineer`
- `Agent: branch-cleaner`
- `Agent: community-coordinator`
- `Agent: team-lead`

This allows us to track which agent made which changes, audit agent behavior, and identify patterns.
NEVER omit the Agent trailer. EVERY commit from a teammate must have one.

## Git Worktrees (MANDATORY for parallel work)

To avoid branch conflicts when multiple agents work simultaneously, each agent MUST use a dedicated git worktree instead of switching branches in the main checkout.

### Setup (Team Lead does this at cycle start)

Before spawning teammates, create a worktree directory:
```bash
mkdir -p WORKTREE_BASE_PLACEHOLDER
```

### Per-Agent Worktree Pattern

When an agent needs to create a branch for a fix or improvement:

```bash
# 1. Create a worktree for the branch (from the main checkout)
git worktree add WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME -b BRANCH-NAME origin/main

# 2. Do all work inside the worktree directory
cd WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME
# ... make changes, run tests ...

# 3. Commit and push from the worktree
git add FILES
git commit -m "message

Agent: agent-name
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push -u origin BRANCH-NAME

# 4. Create PR (can be done from anywhere)
gh pr create --title "title" --body "body"

# 5. Merge and clean up
gh pr merge NUMBER --squash --delete-branch
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH-NAME
```

### Why Worktrees?

- Multiple agents can work on different branches simultaneously without conflicts
- No risk of `git checkout` clobbering another agent's uncommitted changes
- Each agent has a clean, isolated working directory
- The main checkout stays on `main` and is never switched away

### Rules

- NEVER use `git checkout -b` or `git switch` in the main repo when other agents are active
- ALWAYS use `git worktree add` for branch work
- ALWAYS clean up worktrees after the PR is merged: `git worktree remove PATH`
- At end of cycle, team lead runs: `git worktree prune` to clean up stale entries

## Workflow

1. Create the team with TeamCreate
2. Set up worktree directory: mkdir -p WORKTREE_BASE_PLACEHOLDER
3. Create tasks using TaskCreate for each area:
   - Branch cleanup: scan and clean stale remote branches
   - Community coordination: scan all open issues, post acknowledgments, categorize, and delegate
   - Security scan of all scripts
   - UX test of main user flows
   - Complexity reduction in top 5 longest functions
   - Test coverage for recent changes
4. Spawn teammates with Task tool using subagent_type='general-purpose'
5. Assign tasks to teammates using TaskUpdate
6. Branch-cleaner runs first pass on stale branches
7. Community-coordinator engages issues FIRST — posts acknowledgments before other agents start investigating
8. Community-coordinator delegates issue investigations to relevant teammates
9. All agents use worktrees for their branch work (never git checkout in the main repo)
10. Monitor teammate progress via their messages
11. Community-coordinator posts interim updates on issues as teammates report findings
12. Create Sprite checkpoint after successful changes: sprite-env checkpoint create --comment 'Description'
13. Community-coordinator posts final resolutions on all issues, closes them
14. Branch-cleaner runs final pass to catch any branches created during the cycle
15. Team lead runs: git worktree prune to clean stale worktree entries
16. When all work is done, execute the Lifecycle Management shutdown sequence (below) — send shutdown_request to every teammate, wait for confirmations, clean up worktrees, then exit

## Lifecycle Management (MANDATORY — DO NOT EXIT EARLY)

You MUST remain active until ALL of the following are true:

1. **All tasks are completed**: Run TaskList and confirm every task has status "completed"
2. **All PRs are resolved**: Run `gh pr list --repo OpenRouterTeam/spawn --state open --author @me` and confirm zero open PRs from this cycle. Every PR must be either merged or closed with a comment.
3. **All issues are engaged**: Run `gh issue list --repo OpenRouterTeam/spawn --state open`
   and for EACH open issue, verify it has at least one comment. If any issue has zero comments,
   the community-coordinator MUST post an acknowledgment before shutdown proceeds.
4. **All worktrees are cleaned**: Run `git worktree list` and confirm only the main worktree exists. Run `rm -rf WORKTREE_BASE_PLACEHOLDER` and `git worktree prune`.
5. **All teammates are shut down**: Send `shutdown_request` to EVERY teammate. Wait for each to confirm. Do NOT exit while any teammate is still active.

### Shutdown Sequence (execute in this exact order):

1. Check TaskList — if any tasks are still in_progress or pending, wait and check again (poll every 30 seconds, up to 10 minutes)
2. Verify all PRs merged or closed: `gh pr list --repo OpenRouterTeam/spawn --state open`
3. Verify all issues engaged: `gh issue list --repo OpenRouterTeam/spawn --state open`
4. For each teammate, send a `shutdown_request` via SendMessage
5. Wait for all `shutdown_response` confirmations
6. Run final cleanup: `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER`
7. Create checkpoint: `sprite-env checkpoint create --comment 'Refactor cycle complete'`
8. Print final summary of what was accomplished
9. ONLY THEN may the session end

### CRITICAL: If you exit before completing this sequence, running agents will be orphaned and the cycle will be incomplete. This has caused real problems in the past (PR #83 was left unmerged, issues got duplicate comments from overlapping cycles). You MUST wait for all teammates to shut down before exiting.

## Safety Rules

- ALWAYS create Sprite checkpoint BEFORE risky changes
- One logical change per commit
- Run tests after every change
- If 3 consecutive test failures, pause and investigate
- Never break existing functionality
- Focus on high-impact, low-risk improvements

## Priority Scoring

Score tasks: (Impact x Confidence) / Risk
- Impact: 1-10 (how much better will this make spawn?)
- Confidence: 1-10 (how sure are you it is correct?)
- Risk: 1-10 (how likely to break things?)

Target autonomous score: >30

Begin now. Spawn the team and start working. DO NOT EXIT until all teammates are shut down and all cleanup is complete per the Lifecycle Management section above.
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

# Start keep-alive before launching claude (prevents Sprite from pausing the VM)
start_keepalive
log "Keep-alive started (pid=${KEEPALIVE_PID})"

# Run Claude Code with the prompt file, enforcing a hard timeout
CLAUDE_EXIT=0
timeout --signal=TERM --kill-after=60 "${HARD_TIMEOUT}" \
    claude -p "$(cat "${PROMPT_FILE}")" 2>&1 | tee -a "${LOG_FILE}" || CLAUDE_EXIT=$?

if [[ "${CLAUDE_EXIT}" -eq 0 ]]; then
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
elif [[ "${CLAUDE_EXIT}" -eq 124 ]]; then
    log "Cycle timed out after ${HARD_TIMEOUT}s — killed by hard timeout"

    # Still create checkpoint for any partial work that was merged
    log "Creating checkpoint for partial work..."
    sprite-env checkpoint create --comment "${RUN_MODE} cycle timed out (partial)" 2>&1 | tee -a "${LOG_FILE}" || true
else
    log "Cycle failed (exit_code=${CLAUDE_EXIT})"
fi

# Note: cleanup (worktree prune, prompt file removal, final log) handled by trap
