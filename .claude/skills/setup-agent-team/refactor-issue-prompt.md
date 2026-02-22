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
