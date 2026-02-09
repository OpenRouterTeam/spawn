#!/bin/bash
set -eo pipefail

# Refactoring Team Service — Single Cycle
# Triggered by trigger-server.ts via GitHub Actions
# Spawns a Claude Code agent team to maintain and improve the spawn codebase

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

LOG_FILE="/home/sprite/spawn/.docs/refactor.log"
TEAM_NAME="spawn-refactor"

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

log "=== Starting Refactoring Cycle ==="
log "Working directory: ${SCRIPT_DIR}"
log "Team name: ${TEAM_NAME}"
log "Log file: ${LOG_FILE}"

# Ensure we're on latest main
log "Syncing with origin/main..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

# Launch Claude Code with team instructions
log "Launching refactoring team..."

# Write prompt to a temp file to avoid shell escaping issues
PROMPT_FILE=$(mktemp /tmp/refactor-prompt-XXXXXX.md)
cat > "${PROMPT_FILE}" << 'PROMPT_EOF'
You are the Team Lead for the spawn continuous refactoring service.

Your mission: Spawn a team of specialized agents to maintain and improve the spawn codebase autonomously.

## Team Structure

Create these teammates:

1. **security-auditor** (Sonnet)
   - Scan all .sh scripts for command injection, path traversal, credential leaks
   - Check TypeScript code for XSS, prototype pollution, unsafe eval
   - Review OpenRouter API key handling
   - Fix vulnerabilities immediately

2. **ux-engineer** (Sonnet)
   - Test end-to-end user flows (spawn cli -> cloud -> agent launch)
   - Improve error messages (make them actionable and clear)
   - Fix UX papercuts (confusing prompts, unclear help text, broken workflows)
   - Verify all usage examples in READMEs work

3. **complexity-hunter** (Haiku)
   - Find bash functions >50 lines or TypeScript functions >80 lines
   - Reduce cyclomatic complexity without breaking features
   - Extract repeated code patterns into shared utilities
   - Run tests after each refactoring to verify no regressions

4. **test-engineer** (Haiku)
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
   - For EVERY open issue, immediately post an acknowledgment comment:
     gh issue comment NUMBER --body "Thanks for reporting this! Our automated maintenance team is looking into it. We'll post updates here as we investigate."
   - Categorize each issue (bug, feature request, question, already-fixed)
   - For bugs: message the relevant teammate to investigate
     * Security-related → message security-auditor
     * UX/error messages → message ux-engineer
     * Test failures → message test-engineer
     * Code quality → message complexity-hunter
   - Post interim updates on issues as teammates report findings:
     gh issue comment NUMBER --body "Update: We've identified the root cause — [summary]. Working on a fix now."
   - When a fix PR is merged, post the final resolution:
     gh issue comment NUMBER --body "This has been fixed in PR_URL. [Brief explanation of what was changed and why]. The fix is live on main — please try updating and let us know if you still see the issue."
   - Then close: gh issue close NUMBER
   - For feature requests: comment acknowledging the request, label as enhancement, and close with a note pointing to discussions
   - For questions: answer directly in a comment, then close
   - GOAL: Every issue reporter should feel heard and informed. No cold trails.
   - EVERY open issue must be engaged by end of cycle. No dangling issues.

## Issue Fix Workflow (CRITICAL follow exactly)

When fixing a bug reported in a GitHub issue:

1. Community-coordinator posts acknowledgment comment on the issue
2. Community-coordinator messages the relevant teammate to investigate
3. Create a worktree for the fix:
   git worktree add /tmp/spawn-worktrees/fix/issue-NUMBER -b fix/issue-NUMBER origin/main
4. Work inside the worktree: cd /tmp/spawn-worktrees/fix/issue-NUMBER
5. Implement the fix and commit (include Agent: marker)
6. Community-coordinator posts interim update on the issue with root cause summary
7. Push the branch: git push -u origin fix/issue-NUMBER
8. Create a PR that references the issue:
   gh pr create --title "Fix: description" --body "Fixes #NUMBER"
9. Merge the PR immediately: gh pr merge --squash --delete-branch
10. Clean up: git worktree remove /tmp/spawn-worktrees/fix/issue-NUMBER
11. Community-coordinator posts final resolution comment with PR link and explanation
12. Close the issue: gh issue close NUMBER

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
mkdir -p /tmp/spawn-worktrees
```

### Per-Agent Worktree Pattern

When an agent needs to create a branch for a fix or improvement:

```bash
# 1. Create a worktree for the branch (from the main checkout)
git worktree add /tmp/spawn-worktrees/BRANCH-NAME -b BRANCH-NAME origin/main

# 2. Do all work inside the worktree directory
cd /tmp/spawn-worktrees/BRANCH-NAME
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
git worktree remove /tmp/spawn-worktrees/BRANCH-NAME
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
2. Set up worktree directory: mkdir -p /tmp/spawn-worktrees
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
16. When cycle completes, verify: every issue engaged, all PRs merged, zero stale branches, summarize what was fixed/improved

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

Begin now. Spawn the team and start working.
PROMPT_EOF

# Run Claude Code with the prompt file
if claude -p "$(cat "${PROMPT_FILE}")" 2>&1 | tee -a "${LOG_FILE}"; then
    log "Cycle completed successfully"

    # Commit any changes made during the cycle
    if [[ -n "$(git status --porcelain)" ]]; then
        log "Committing changes from cycle..."
        git add -A
        git commit -m "refactor: Automated improvements

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" 2>&1 | tee -a "${LOG_FILE}" || true

        # Push to main
        git push origin main 2>&1 | tee -a "${LOG_FILE}" || true
    fi

    # Create checkpoint
    log "Creating checkpoint..."
    sprite-env checkpoint create --comment "Refactor cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
else
    log "Cycle failed"
fi

# Clean up prompt file
rm -f "${PROMPT_FILE}"

log "=== Refactoring Cycle Done ==="
