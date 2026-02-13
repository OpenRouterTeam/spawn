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

    log "Pre-cycle cleanup: checking stale open PRs for conflicts..."
    STALE_PRS=$(gh pr list --repo OpenRouterTeam/spawn --state open --json number,updatedAt,mergeable --jq '.[] | select(.updatedAt < (now - 7200 | todate)) | "\(.number) \(.mergeable)"' 2>/dev/null) || true
    while IFS=' ' read -r pr_num pr_mergeable; do
        if [[ -n "$pr_num" ]]; then
            if [[ "$pr_mergeable" != "MERGEABLE" ]]; then
                log "Stale PR #${pr_num} has conflicts — will be handled by pr-maintainer agent"
            else
                log "Stale PR #${pr_num} is mergeable — will be reviewed by security team"
            fi
        fi
    done <<< "$STALE_PRS"
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

2. **issue-tester** (Haiku)
   - Review the fix for correctness and edge cases
   - Run \`bun test\` to verify no regressions
   - Run \`bash -n\` on any modified .sh files
   - Report test results to the team lead

## Label Management (MANDATORY)

Track issue lifecycle with labels: "pending-review" → "under-review" → "in-progress"

- At cycle start, transition the issue to "in-progress":
  \`gh issue edit ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --remove-label "pending-review" --remove-label "under-review" --add-label "in-progress"\`
- When the fix is merged and the issue is closed, remove all status labels:
  \`gh issue edit ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --remove-label "in-progress"\`
- Always check current labels first to avoid errors:
  \`gh issue view ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --json labels --jq '.labels[].name'\`

## Workflow

1. Create the team with TeamCreate
2. Fetch issue details: \`gh issue view ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn\`
3. Transition label to "in-progress":
   \`gh issue edit ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --remove-label "pending-review" --remove-label "under-review" --add-label "in-progress"\`
4. DEDUP CHECK: Check if issue already has comments from automated accounts:
   \`gh issue view ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --json comments --jq '.comments[].author.login'\`
   Only post acknowledgment if no automated comments exist.
5. Post acknowledgment comment on the issue (if not already acknowledged):
   \`gh issue comment ${SPAWN_ISSUE} --repo OpenRouterTeam/spawn --body "Thanks for flagging this! Looking into it now.\n\n-- refactor/issue-fixer"\`
6. Create worktree: \`git worktree add ${WORKTREE_BASE} -b fix/issue-${SPAWN_ISSUE} origin/main\`
7. Spawn issue-fixer to work in \`${WORKTREE_BASE}\`
8. Spawn issue-tester to review and test
9. When fix is ready:
   - Push: \`git push -u origin fix/issue-${SPAWN_ISSUE}\`
   - PR: \`gh pr create --title "fix: Description" --body "Fixes #${SPAWN_ISSUE}\n\n-- refactor/issue-fixer"\`
10. Post update comment on the issue linking to the PR
11. Do NOT close the issue — the PR body contains \`Fixes #${SPAWN_ISSUE}\` which will auto-close the issue when the PR is merged
12. Clean up worktree: \`git worktree remove ${WORKTREE_BASE}\`
13. Shutdown all teammates and exit

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

## Separation of Concerns (MANDATORY)

The refactor team **creates PRs** — the security team **reviews and merges** them.

### What refactor agents MUST do:
1. **Research deeply**: Use web search, code exploration, and deep-dives to understand the problem before writing code
2. **Create a PR** with clear title and description explaining the change and rationale
3. **Leave the PR open** — the security team handles review, approval, and merge

### What refactor agents must NEVER do:
- `gh pr review` — NEVER review PRs (that's the security team's job)
- `gh pr merge` — NEVER merge PRs
- Approve or request changes on any PR

### Why:
- Clear ownership: refactor team solves problems, security team gates quality
- Prevents unreviewed code from landing
- Lets each team focus on what they do best

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

5. **pr-maintainer** (Sonnet)
   - **Role: Keep PRs healthy and mergeable. Do NOT review, approve, or merge PRs — that is the security team's responsibility.**
   - FIRST TASK: List ALL open PRs: `gh pr list --repo OpenRouterTeam/spawn --state open --json number,title,headRefName,updatedAt,mergeable,reviewDecision`
   - For EACH open PR, evaluate and take the appropriate action:
     * **Has merge conflicts**: rebase the PR branch onto main to resolve
       ```
       git fetch origin
       BRANCH=$(gh pr view NUMBER --repo OpenRouterTeam/spawn --json headRefName --jq '.headRefName')
       git worktree add /tmp/spawn-worktrees/pr-rebase-NUMBER origin/$BRANCH
       cd /tmp/spawn-worktrees/pr-rebase-NUMBER
       git rebase origin/main
       # If rebase succeeds: force-push the branch
       git push --force-with-lease origin $BRANCH
       cd /path/to/repo
       git worktree remove /tmp/spawn-worktrees/pr-rebase-NUMBER --force
       ```
       If rebase has unresolvable conflicts, post a comment:
       `gh pr comment NUMBER --repo OpenRouterTeam/spawn --body "Attempted to rebase onto main but conflicts couldn't be auto-resolved. Manual resolution needed.\n\n-- refactor/pr-maintainer"`
     * **Has review comments requesting changes**: read the review comments, address them with code fixes in a worktree
       ```
       gh pr view NUMBER --repo OpenRouterTeam/spawn --json reviews --jq '.reviews[] | select(.state == "CHANGES_REQUESTED") | .body'
       gh api repos/OpenRouterTeam/spawn/pulls/NUMBER/comments --jq '.[].body'
       ```
       - Check out the PR branch in a worktree, make the requested fixes, commit, and push
       - Post a comment summarizing what was addressed:
         `gh pr comment NUMBER --repo OpenRouterTeam/spawn --body "Addressed review feedback:\n- [list of changes]\n\n-- refactor/pr-maintainer"`
     * **Failing checks**: investigate the failure in a worktree, fix if trivial (e.g., `bash -n` errors, test failures), push the fix
       - If the failure is non-trivial, comment with failure details for the author
     * **Mergeable + no issues**: leave it alone — the security team handles review and merge
   - ALSO clean up orphan branches (no open PR, stale >4 hours): `git push origin --delete BRANCH`
   - **NEVER review, approve, or merge PRs** — that is exclusively the security team's job
   - **NEVER close a PR** — always try to rebase, fix, or request changes instead
   - After processing all PRs, report summary: how many rebased, fixed, commented, branches cleaned
   - Run this check AGAIN at the end of the cycle to catch PRs created during the cycle
   - GOAL: All open PRs are conflict-free, review feedback is addressed, and checks are passing — ready for security review.

6. **community-coordinator** (Sonnet)
   - FIRST TASK: Run `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt`
   - LABEL MANAGEMENT (MANDATORY for every issue interaction):
     Labels track issue lifecycle: "pending-review" → "under-review" → "in-progress"
     * When you FIRST discover an issue that has NO status label (none of the three above):
       `gh issue edit NUMBER --repo OpenRouterTeam/spawn --add-label "pending-review"`
     * When you acknowledge/engage an issue (post first comment):
       `gh issue edit NUMBER --repo OpenRouterTeam/spawn --remove-label "pending-review" --add-label "under-review"`
     * When you delegate an issue to a teammate for a fix:
       `gh issue edit NUMBER --repo OpenRouterTeam/spawn --remove-label "pending-review" --remove-label "under-review" --add-label "in-progress"`
     * When the fix is merged and the issue is closed, remove all status labels:
       `gh issue edit NUMBER --repo OpenRouterTeam/spawn --remove-label "pending-review" --remove-label "under-review" --remove-label "in-progress"`
     Always check existing labels before adding/removing to avoid errors:
       `gh issue view NUMBER --repo OpenRouterTeam/spawn --json labels --jq '.labels[].name'`
   - DEDUP CHECK (MANDATORY before ANY comment): For each issue, FIRST check existing comments:
     `gh issue view NUMBER --repo OpenRouterTeam/spawn --json comments --jq '.comments[] | "\(.author.login): \(.body[-30:])"'`
     If the issue already has a comment containing `-- refactor/community-coordinator`, SKIP posting — you've already commented.
     Also check for comments from other automated accounts. Only post if no similar comment exists.
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
     gh issue comment NUMBER --body "Update: We've identified the root cause — [summary]. Working on a fix now.\n\n-- refactor/community-coordinator"
   - When a fix PR is created, post an update linking to it (only if no similar update exists):
     gh issue comment NUMBER --body "A fix is up in PR_URL. [Brief explanation of what was changed and why]. The issue will auto-close when the PR is merged.\n\n-- refactor/community-coordinator"
   - Do NOT close issues manually — PRs contain \`Fixes #NUMBER\` which auto-closes the issue on merge
   - For feature requests: comment acknowledging the request and label as enhancement (do NOT close — let the implementing PR close it)
   - For questions: answer directly in a comment (do NOT close — the reporter may have follow-ups)
   - GOAL: Every issue reporter should feel heard and informed. No cold trails.
   - PERIODIC RE-SCAN: After your initial scan AND after every 5 minutes, re-run
     `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt`
     to catch issues filed DURING the cycle. Apply the same dedup + engagement workflow.
   - FINAL SWEEP (MANDATORY before shutdown): Do one last issue scan. Any new issues must be
     acknowledged before the cycle ends. If there's no time to fix them, at minimum post an
     acknowledgment comment so the reporter knows we've seen it.
   - EVERY open issue must be engaged by end of cycle. No dangling issues.
   - NEVER post duplicate comments. One acknowledgment per issue. One resolution per issue.
   - **SIGN-OFF**: Every comment MUST end with a sign-off line: `-- refactor/community-coordinator`. This is how agents identify their own comments for dedup.

## Issue Fix Workflow (CRITICAL follow exactly)

When fixing a bug reported in a GitHub issue:

1. Community-coordinator checks for existing comments (dedup) before posting acknowledgment
2. Community-coordinator transitions label to "under-review":
   `gh issue edit NUMBER --repo OpenRouterTeam/spawn --remove-label "pending-review" --add-label "under-review"`
3. Community-coordinator posts acknowledgment comment on the issue (only if not already acknowledged)
4. Community-coordinator messages the relevant teammate to investigate
5. Community-coordinator transitions label to "in-progress" when delegating:
   `gh issue edit NUMBER --repo OpenRouterTeam/spawn --remove-label "under-review" --add-label "in-progress"`
6. Create a worktree for the fix:
   git worktree add WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER -b fix/issue-NUMBER origin/main
7. Work inside the worktree: cd WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER
8. Implement the fix and commit (include Agent: marker)
9. Community-coordinator posts interim update on the issue with root cause summary (only if no similar update exists)
10. Push the branch: git push -u origin fix/issue-NUMBER
11. Create a PR that references the issue:
    gh pr create --title "Fix: description" --body "Fixes #NUMBER

-- refactor/AGENT-NAME"
12. Clean up: git worktree remove WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER
13. Community-coordinator posts update comment with PR link (only if no similar update exists)
14. Do NOT close the issue — the PR body contains \`Fixes #NUMBER\` which will auto-close the issue when merged

If a PR cannot be created (conflicts, superseded, etc.), close it WITH a comment explaining why.
NEVER close a PR silently — every closed PR MUST have a comment.
NEVER close an issue manually — let the PR merge auto-close it via \`Fixes #NUMBER\`.
The full cycle is: acknowledge → investigate → worktree → fix → update → PR (references issue with \`Fixes #NUMBER\`) → cleanup worktree.
Note: review and merging is handled by the security team. Issues close automatically when the PR merges.

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
- `Agent: pr-maintainer`
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
gh pr create --title "title" --body "body

-- refactor/AGENT-NAME"

# 5. Clean up worktree (PR stays open for security team review)
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
   - PR maintenance: rebase conflicting PRs, address review comments, fix failing checks; clean orphan branches
   - Community coordination: scan all open issues, post acknowledgments, categorize, and delegate
   - Security scan of all scripts
   - UX test of main user flows
   - Complexity reduction in top 5 longest functions
   - Test coverage for recent changes
4. Spawn teammates with Task tool using subagent_type='general-purpose'
5. Assign tasks to teammates using TaskUpdate
6. PR-maintainer maintains all open PRs: rebase conflicting ones, address review comments, fix failing checks
7. Community-coordinator engages issues FIRST — posts acknowledgments before other agents start investigating
8. Community-coordinator delegates issue investigations to relevant teammates
9. All agents use worktrees for their branch work (never git checkout in the main repo)
10. **Enter the monitoring loop** (see below) — stay alive and coordinate until all teammates finish
11. Community-coordinator posts interim updates on issues as teammates report findings
12. Create Sprite checkpoint after successful changes: sprite-env checkpoint create --comment 'Description'
13. Community-coordinator posts final resolutions on all issues, closes them
14. PR-maintainer runs final pass to catch any new PRs created during the cycle
15. Team lead runs: git worktree prune to clean stale worktree entries
16. When all work is done, execute the Lifecycle Management shutdown sequence (below) — send shutdown_request to every teammate, wait for confirmations, clean up worktrees, then exit

## CRITICAL: Staying Alive (DO NOT SKIP)

**Spawning teammates is the BEGINNING of your job, not the end.** After spawning all teammates, you MUST actively monitor them. If you end your conversation after spawning, teammates become orphaned with no coordination.

### TECHNICAL REQUIREMENT: You are running in `claude -p` (print) mode. Your session ENDS the moment you produce a response with no tool call. You MUST include at least one tool call in every response.

**How message delivery works:** Teammate messages arrive as new user turns BETWEEN your responses. A long `sleep 30` blocks your turn for 30 seconds — during which messages queue up but can't be delivered. Use `sleep 5` to briefly yield, then check for messages.

### Required pattern after spawning:
```
1. Spawn all teammates via Task tool
2. Yield loop (keep it tight):
   a. Bash("sleep 5") — yield the turn so queued messages can be delivered
   b. If a message arrived, process it immediately (acknowledge, update task)
   c. If no message, run TaskList — if tasks still pending, go back to (a)
   d. Between polls, do useful work: check PR status, verify teammate health
   e. If the time budget is almost up, send wrap-up messages to all teammates
3. Only after ALL teammates have finished, proceed to shutdown
```

**DO NOT loop on `sleep 15` or `sleep 30`.** Each sleep blocks message delivery. Keep sleeps to 5 seconds max.

### Common mistake (DO NOT DO THIS):
```
BAD:  Spawn teammates → "I'll wait for their messages" → session ends (agents orphaned!)
BAD:  Spawn teammates → sleep 30 → sleep 30 → sleep 30 → ... (messages can't be delivered!)
GOOD: Spawn teammates → sleep 5 → process message → sleep 5 → TaskList → ... → shutdown
```

## Lifecycle Management (MANDATORY — DO NOT EXIT EARLY)

You MUST remain active until ALL of the following are true:

1. **All tasks are completed**: Run TaskList and confirm every task has status "completed"
2. **All PRs are created**: Verify PRs from this cycle exist and have clear descriptions. PRs stay open for the security team to review and merge.
3. **All issues are engaged and labeled**: Run `gh issue list --repo OpenRouterTeam/spawn --state open --json number,labels`
   and for EACH open issue, verify it has at least one comment AND has a status label
   ("pending-review", "under-review", or "in-progress"). If any issue is missing a status
   label, add "pending-review". If any issue has zero comments, the community-coordinator
   MUST post an acknowledgment before shutdown proceeds.
4. **All worktrees are cleaned**: Run `git worktree list` and confirm only the main worktree exists. Run `rm -rf WORKTREE_BASE_PLACEHOLDER` and `git worktree prune`.
5. **All teammates are shut down**: Send `shutdown_request` to EVERY teammate. Wait for each to confirm. Do NOT exit while any teammate is still active.

### Shutdown Sequence (execute in this exact order):

1. Check TaskList — if any tasks are still in_progress or pending, yield with `sleep 5` and check again (up to 10 minutes)
2. Verify all PRs from this cycle have been created with clear descriptions
3. Verify all issues engaged: `gh issue list --repo OpenRouterTeam/spawn --state open`
4. For each teammate, send a `shutdown_request` via SendMessage
5. Wait for all `shutdown_response` confirmations
6. Run final cleanup: `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER`
7. Create checkpoint: `sprite-env checkpoint create --comment 'Refactor cycle complete'`
8. Print final summary of what was accomplished
9. ONLY THEN may the session end

### CRITICAL: If you exit before completing this sequence, running agents will be orphaned and the cycle will be incomplete. This has caused real problems in the past (PR #83 was left unmerged, issues got duplicate comments from overlapping cycles). You MUST wait for all teammates to shut down before exiting.

## Safety Rules

- NEVER close a PR — always rebase, fix, request changes, or comment instead. PRs represent work; closing them loses that work.
- ALWAYS create Sprite checkpoint BEFORE risky changes
- One logical change per commit
- Run tests after every change
- If 3 consecutive test failures, pause and investigate
- Never break existing functionality
- Focus on high-impact, low-risk improvements
- **SIGN-OFF**: Every comment on issues/PRs MUST end with `-- refactor/AGENT-NAME` (e.g., `-- refactor/community-coordinator`, `-- refactor/pr-maintainer`, `-- refactor/security-auditor`). This is how agents identify their own comments for dedup across cycles.

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

# NOTE: VM keep-alive is handled by the trigger server streaming output back
# to the GitHub Actions runner. The long-lived HTTP response keeps Sprite alive.

# Activity watchdog: kill claude if no output for IDLE_TIMEOUT seconds.
# This catches hung API calls (pre-flight check hangs, network issues) much
# faster than the hard timeout. The next cron trigger starts a fresh cycle.
# 10 min is long enough for legitimate agent work (agents send messages every
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
    # After this, claude hangs waiting for agent subprocesses — kill immediately.
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
