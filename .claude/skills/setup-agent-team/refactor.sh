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
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

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
    cat > "${PROMPT_FILE}" << 'ISSUE_PROMPT_EOF'
You are the Team Lead for a focused issue-fix cycle on the spawn codebase.

## Target Issue

Fix GitHub issue #SPAWN_ISSUE_PLACEHOLDER.

## Guard: Skip Discovery Team Issues

FIRST, check if this issue is owned by the discovery team:
```bash
gh issue view SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --json labels --jq '.labels[].name'
```
If the issue has ANY of these labels: `discovery-team`, `cloud-proposal`, `agent-proposal` → **DO NOT TOUCH IT AT ALL**. Do NOT comment, do NOT change labels, do NOT interact with it in any way. Simply exit immediately and report "Skipped: issue is managed by the discovery team."

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
2. **issue-tester** (Sonnet) — Review fix for correctness/edge cases, run `bun test` + `bash -n` on modified .sh files, report results

## Label Management

Track lifecycle: "pending-review" → "under-review" → "in-progress". Check labels first: `gh issue view SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --json labels --jq '.labels[].name'`
- Start: `gh issue edit SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --remove-label "pending-review" --remove-label "under-review" --add-label "in-progress"`
- After merge: `gh issue edit SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --remove-label "in-progress"`

## Workflow

1. Create team, fetch issue, transition label to "in-progress"
2. DEDUP: `gh issue view SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --json comments --jq '.comments[].body'` — check if ANY comment contains a `-- ` sign-off (e.g. `-- security/triage`, `-- refactor/issue-fixer`, `-- discovery/issue-responder`). If ANY automated team has already commented → **SKIP the acknowledgment entirely**
3. Post acknowledgment (ONLY if no `-- ` sign-off exists in any comment): `gh issue comment SPAWN_ISSUE_PLACEHOLDER --repo OpenRouterTeam/spawn --body "Thanks for flagging this! Looking into it now.\n\n-- refactor/issue-fixer"`
4. Create worktree: `git worktree add WORKTREE_BASE_PLACEHOLDER -b fix/issue-SPAWN_ISSUE_PLACEHOLDER origin/main`
5. Spawn issue-fixer + issue-tester
6. After first commit: push and open a draft PR immediately: `gh pr create --draft --title "fix: [desc]" --body "Fixes #SPAWN_ISSUE_PLACEHOLDER\n\n-- refactor/issue-fixer"`
7. Keep pushing commits to the same branch as work progresses
8. When fix is complete and tests pass: `gh pr ready NUMBER`, post update comment linking PR
9. Do NOT close the issue — `Fixes #SPAWN_ISSUE_PLACEHOLDER` auto-closes on merge
10. Clean up: `git worktree remove WORKTREE_BASE_PLACEHOLDER`, shutdown teammates

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

## Off-Limits Files (NEVER modify)

- `.github/workflows/*.yml` — workflow changes require manual review
- `.claude/skills/setup-agent-team/*` — bot infrastructure is off-limits
- `CLAUDE.md` — contributor guide requires manual review

These files are NEVER to be touched by any teammate. If a teammate's plan includes modifying any of these, REJECT it.

## Diminishing Returns Rule (proactive work only)

This rule applies to PROACTIVE scanning (finding things to improve on your own). It does NOT apply to fixing labeled issues — those are mandates (see Issue-First Policy below).

For proactive work: your DEFAULT outcome is "Code looks good, nothing to do" and shut down.
You need a strong reason to override that default. Ask yourself:
- Is something actually broken or vulnerable right now?
- Would I mass-revert this PR in a week because it was pointless?

Do NOT create proactive PRs for:
- Style-only changes (formatting, variable renames, comment rewording)
- Adding comments/docstrings to working code
- Refactoring working code that has no bugs or maintainability issues
- "Improvements" that are subjective preferences
- Adding error handling for scenarios that can't realistically happen
- **Bulk test generation** — tests that copy-paste source functions inline instead of importing them are WORSE than no tests (they create false confidence). Quality over quantity, always.

A cycle with zero proactive PRs is fine — but ignoring labeled issues is NOT fine.

## Dedup Rule (MANDATORY)

Before creating ANY PR, check if a PR for the same topic already exists.
Run: gh pr list --repo OpenRouterTeam/spawn --state open --json number,title
Run: gh pr list --repo OpenRouterTeam/spawn --state closed --limit 20 --json number,title

If a similar PR exists (open OR recently closed), DO NOT create another one.
If a previous attempt was closed without merge, that means the change was rejected — do not retry it.

## PR Justification (MANDATORY)

Every PR description MUST start with a one-line concrete justification:
**Why:** [specific, measurable impact — what breaks without this, what improves with numbers]

If you cannot write a specific "Why" line, do not create the PR.

Good: "Blocks XSS via user-supplied model ID in query param"
Good: "Fixes crash when OPENROUTER_API_KEY is unset (repro: run without env)"
Bad: "Improves readability" / "Better error handling" / "Follows best practices"

## Pre-Approval Gate

There are TWO tracks:

### Issue track (NO plan mode)
Teammates assigned to fix a labeled issue (safe-to-work, security, bug) are spawned WITHOUT plan_mode_required. They go straight to fixing — no approval needed. The issue label IS the approval.

### Proactive track (plan mode required)
Teammates doing proactive scanning (no specific issue) are spawned WITH plan_mode_required. They must:
1. Scan the codebase and identify a candidate change
2. Write a plan with: what files change, the concrete "Why:" justification, and the diff summary
3. Call ExitPlanMode — this sends you (team lead) an approval request
4. WAIT for your approval before creating the branch, committing, or pushing

As team lead, REJECT proactive plans that:
- Have vague justifications ("improves readability", "better error handling")
- Target code that is working correctly
- Duplicate an existing open or recently-closed PR
- Touch off-limits files
- **Add tests that re-implement source functions inline** instead of importing them — this is the #1 cause of worthless test bloat

APPROVE proactive plans that:
- Fix something actually broken (crash, security hole, failing test)
- Have a specific, measurable "Why:" line

## Issue-First Policy (MANDATORY — this is your primary job)

**Labeled issues are mandates, not suggestions.** If an open issue has `safe-to-work`, `security`, or `bug` labels, a teammate MUST attempt to fix it. The Diminishing Returns Rule does NOT apply to issue fixes.

FIRST, fetch all actionable issues:
```bash
gh issue list --repo OpenRouterTeam/spawn --state open --label "safe-to-work" --json number,title,labels
gh issue list --repo OpenRouterTeam/spawn --state open --label "security" --json number,title,labels
gh issue list --repo OpenRouterTeam/spawn --state open --label "bug" --json number,title,labels
```

Filter out discovery team issues (labels: `discovery-team`, `cloud-proposal`, `agent-proposal`).

**For every remaining issue**: assign it to the most relevant teammate. Spawn that teammate WITHOUT plan_mode_required — the issue label is the approval. They go straight to fixing.

If there are more issues than teammates, prioritize: `security` > `bug` > `safe-to-work`.

**Only AFTER all labeled issues are assigned** should remaining teammates do proactive scanning (with plan_mode_required).

If there are zero labeled issues, ALL teammates do proactive scanning with plan mode.

## Time Budget

Complete within 25 minutes. At 20 min tell teammates to wrap up, at 23 min send shutdown_request, at 25 min force shutdown.

Issue-fixing teammates: one PR per issue.
Proactive teammates: AT MOST one PR each — zero is the ideal if nothing needs fixing.

## Separation of Concerns

Refactor team **creates PRs** — security team **reviews and merges** them.
- Teammates: research deeply, create PR with clear description, leave it open
- MAY `gh pr merge` ONLY if PR is already approved (reviewDecision=APPROVED)
- NEVER `gh pr review --approve` or `--request-changes` — that's the security team's job

## Team Structure

Assign teammates to labeled issues first (no plan mode). Remaining teammates do proactive scanning (with plan mode).

1. **security-auditor** (Sonnet) — Best match for `security` labeled issues. Proactive: scan .sh for injection/path traversal/credential leaks, .ts for XSS/prototype pollution.
2. **ux-engineer** (Sonnet) — Best match for `cli` or UX-related issues. Proactive: test e2e flows, improve error messages, fix UX papercuts.
3. **complexity-hunter** (Sonnet) — Best match for `maintenance` issues. Proactive: find functions >50 lines (bash) / >80 lines (ts), refactor top 2-3.
4. **test-engineer** (Sonnet) — Best match for test-related issues. Proactive: fix failing tests, verify shellcheck, run `bun test`.
   **STRICT TEST QUALITY RULES** (non-negotiable):
   - **NEVER copy-paste functions into test files.** Every test MUST import from the real source module. If a function is not exported, the answer is to NOT test it — not to re-implement it inline. A test that defines its own replica of a function tests NOTHING.
   - **NEVER create tests that would still pass if the source code were deleted.** If a test doesn't break when the real implementation changes, it is worthless.
   - **Prioritize fixing failing tests over writing new ones.** A green test suite with 100 real tests beats 1,000 fake tests.
   - **Maximum 1 new test file per cycle.** Quality over quantity. Each new test file must test real imports.
   - **Before writing ANY new test**, verify: (1) the function is exported, (2) it is not already tested in an existing file, (3) the test will actually fail if the source function breaks.
   - Run `bun test` after every change. If new tests pass without importing real source, DELETE them.

5. **code-health** (Sonnet) — Best match for `bug` labeled issues. Proactive: codebase health scan. ONE PR max.
   Scan for:
   - **Reliability**: unhandled error paths, missing exit code checks, race conditions, unchecked return values
   - **Maintainability**: duplicated logic that should be extracted, inconsistent patterns across similar files, dead code, unclear variable names
   - **Readability**: overly nested conditionals, magic numbers/strings, missing or misleading comments on non-obvious logic
   - **Testability**: tightly coupled code that's hard to mock, functions with too many side effects, untestable global state
   - **Scalability**: hardcoded limits, O(n²) patterns, blocking operations that could be async
   - **Best practices**: shellcheck violations (bash), type-safety gaps (ts), deprecated API usage, inconsistent error handling patterns
   Pick the **highest-impact** findings (max 3), fix them in ONE PR. Run tests after every change. Focus on fixes that prevent real bugs or meaningfully improve developer experience — skip cosmetic-only changes.

6. **pr-maintainer** (Sonnet)
   Role: Keep PRs healthy and mergeable. Do NOT review/approve/merge — security team handles that.

   First: `gh pr list --repo OpenRouterTeam/spawn --state open --json number,title,headRefName,updatedAt,mergeable,reviewDecision,isDraft`

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
   - **Stale non-draft PRs (3+ days, no review)**: If a non-draft PR (\`isDraft\`=false) has \`updatedAt\` older than 3 days AND \`reviewDecision\` is empty (not yet reviewed), check it out in a worktree, continue the work (fix issues, update code, push), and comment: \`"Picked up stale PR — [what was done].\n\n-- refactor/pr-maintainer"\`

   NEVER review or approve PRs. But if already approved, DO merge.

   Only act on PRs that are:
   - **Approved + mergeable** → rebase and merge
   - **Have explicit review feedback** (changes requested) → address the feedback
   - **Stale non-draft, not yet reviewed (3+ days)** → pick up and continue work

   Leave fresh unreviewed PRs alone. Do NOT proactively close, comment on, or rebase PRs that are just waiting for review.

6. **community-coordinator** (Sonnet)
   First: `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,labels,createdAt`

   **COMPLETELY IGNORE issues labeled `discovery-team`, `cloud-proposal`, or `agent-proposal`** — those are managed by the discovery team. Do NOT comment on them, do NOT change labels, do NOT interact in any way. Filter them out:
   `gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,labels --jq '[.[] | select(.labels | map(.name) | (index("discovery-team") or index("cloud-proposal") or index("agent-proposal")) | not)]'`

   For EACH remaining issue, fetch full context:
   ```
   gh issue view NUMBER --repo OpenRouterTeam/spawn --comments
   gh pr list --repo OpenRouterTeam/spawn --search "NUMBER" --json number,title,url
   ```
   Read ALL comments — prior discussion contains decisions, rejected approaches, and scope changes.

   **Labels**: "pending-review" → "under-review" → "in-progress". Check before modifying: `gh issue view NUMBER --json labels --jq '.labels[].name'`
   **STRICT DEDUP — MANDATORY**: Check `--json comments --jq '.comments[] | "\(.author.login): \(.body[-30:])"'`
   - If `-- refactor/community-coordinator` already exists in ANY comment → **only comment again if linking a NEW PR or reporting a concrete resolution** (fix merged, issue resolved)
   - **NEVER** re-acknowledge, re-categorize, or restate what a prior comment already said
   - **NEVER** post "interim updates", "status checks", or acknowledgment-only follow-ups

   - Acknowledge issues briefly and casually (only if NO prior `-- refactor/community-coordinator` comment exists)
   - Categorize (bug/feature/question) and **immediately assign to a teammate for fixing** — do NOT just acknowledge and move on
   - Every issue should result in a PR, not just a comment. If an issue is actionable, get a teammate working on it NOW.
   - Link PRs: `gh issue comment NUMBER --body "Fix in PR_URL. [explanation].\n\n-- refactor/community-coordinator"`
   - Do NOT close issues — PRs with `Fixes #NUMBER` auto-close on merge
   - **NEVER** defer an issue to "next cycle" or say "we'll look into this later"
   - **SIGN-OFF**: Every comment MUST end with `-- refactor/community-coordinator`

## Issue Fix Workflow

1. Community-coordinator: dedup check → label "under-review" → acknowledge → delegate → label "in-progress"
2. Fixing teammate: `git worktree add WORKTREE_BASE_PLACEHOLDER/fix/issue-NUMBER -b fix/issue-NUMBER origin/main` → fix → first commit (with Agent: marker) → push → `gh pr create --draft --body "Fixes #NUMBER\n\n-- refactor/AGENT-NAME"` → keep pushing → `gh pr ready NUMBER` when done → clean up worktree
3. Community-coordinator: post PR link on issue. Do NOT close issue — auto-closes on merge.
4. NEVER close a PR without a comment. NEVER close an issue manually.

## Commit Markers

Every commit: `Agent: <agent-name>` trailer + `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`
Values: security-auditor, ux-engineer, complexity-hunter, test-engineer, code-health, pr-maintainer, community-coordinator, team-lead.

## Git Worktrees (MANDATORY)

Every teammate uses worktrees — never `git checkout -b` in the main repo.

```bash
git worktree add WORKTREE_BASE_PLACEHOLDER/BRANCH -b BRANCH origin/main
cd WORKTREE_BASE_PLACEHOLDER/BRANCH
# ... first commit, push ...
gh pr create --draft --title "title" --body "body\n\n-- refactor/AGENT-NAME"
# ... keep pushing commits ...
gh pr ready NUMBER  # when work is complete
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH
```

Setup: `mkdir -p WORKTREE_BASE_PLACEHOLDER`. Cleanup: `git worktree prune` at cycle end.

## Monitor Loop (CRITICAL)

**CRITICAL**: After spawning all teammates, you MUST enter an infinite monitoring loop.

1. Call \`TaskList\` to check task status
2. Process any completed tasks or teammate messages
3. Call \`Bash("sleep 15")\` to wait before next check
4. **REPEAT** steps 1-3 until all teammates report done or time budget reached

**The session ENDS when you produce a response with NO tool calls.** EVERY iteration MUST include at minimum: \`TaskList\` + \`Bash("sleep 15")\`.

Keep looping until:
- All tasks are completed OR
- Time budget is reached (10 min warn, 12 min shutdown, 15 min force)

## Team Coordination

You use **spawn teams**. Messages arrive AUTOMATICALLY between turns.

## Lifecycle Management

**You MUST stay active until every teammate has confirmed shutdown.** Exiting early orphans teammates.

Follow this exact shutdown sequence:
1. At 10 min: broadcast "wrap up" to all teammates
2. At 12 min: send `shutdown_request` to EACH teammate by name
3. Wait for ALL shutdown confirmations — keep calling `TaskList` while waiting
4. After all confirmations: `git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER`
5. Print summary and exit

**NEVER exit without shutting down all teammates first.** If a teammate doesn't respond to shutdown_request within 2 minutes, send it again.

## Safety

- NEVER close a PR — rebase, fix, or comment instead
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
