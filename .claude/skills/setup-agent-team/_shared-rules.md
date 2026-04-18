# Shared Agent Team Rules

These rules are binding for ALL agent teams (refactor, security, discovery, QA). Team-lead prompts reference this file instead of inlining these blocks.

## Off-Limits Files

- `.github/workflows/*.yml` — workflow changes require manual review
- `.claude/skills/setup-agent-team/*` — bot infrastructure is off-limits
- `CLAUDE.md` — contributor guide requires manual review

If a teammate's plan touches any of these, REJECT it.

## Diminishing Returns Rule (proactive work only)

Does NOT apply to labeled issues or mandated tasks — those must be done.

For proactive work: default outcome is "nothing to do, shut down." Override only if something is actually broken or vulnerable. Do NOT create proactive PRs for: style-only changes, adding comments/docstrings, refactoring working code, subjective improvements, error handling for impossible scenarios, or bulk test generation.

## Dedup Rule

Before ANY PR: `gh pr list --repo OpenRouterTeam/spawn --state open` and `--state closed --limit 20`. If a similar PR exists (open or recently closed), do not create another. Closed-without-merge means rejected — do not retry.

## PR Justification

Every PR description MUST start with: **Why:** [specific, measurable impact].
Good: "Blocks XSS via user-supplied model ID" / "Fixes crash when API key unset"
Bad: "Improves readability" / "Better error handling" / "Follows best practices"
If you cannot write a specific "Why:" line, do not create the PR.

## Git Worktrees

Every teammate uses worktrees — never `git checkout -b` in the main repo.
```bash
git worktree add WORKTREE_BASE_PLACEHOLDER/BRANCH -b BRANCH origin/main
cd WORKTREE_BASE_PLACEHOLDER/BRANCH
# ... work, commit, push, create PR ...
git worktree remove WORKTREE_BASE_PLACEHOLDER/BRANCH
```
Setup: `mkdir -p WORKTREE_BASE_PLACEHOLDER`. Cleanup: `git worktree prune` at cycle end.

## Commit Markers

Every commit: `Agent: <agent-name>` trailer + `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`.

## Monitor Loop

After spawning all teammates, enter an infinite monitoring loop:
1. `TaskList` to check status
2. Process completed tasks / teammate messages
3. `Bash("sleep 15")` to wait
4. REPEAT until all done or time budget reached

EVERY iteration MUST include `TaskList` + `Bash("sleep 15")`. The session ENDS when you produce a response with NO tool calls.

## Shutdown Protocol

1. At T-5min: broadcast "wrap up" to all teammates
2. At T-2min: send `shutdown_request` to each teammate by name
3. After 3 unanswered requests (~6 min), stop waiting — proceed regardless
4. In ONE turn: call `TeamDelete` (proceed regardless of result), then run cleanup:
   ```bash
   rm -f ~/.claude/teams/TEAM_NAME_PLACEHOLDER.json && rm -rf ~/.claude/tasks/TEAM_NAME_PLACEHOLDER/ && git worktree prune && rm -rf WORKTREE_BASE_PLACEHOLDER
   ```
5. Output a plain-text summary with NO further tool calls. Any tool call after step 4 causes an infinite shutdown loop in non-interactive mode.

## Comment Dedup

Before posting ANY comment on a PR or issue, check for existing signatures from the same team. Never duplicate acknowledgments, status updates, or re-triages. Only comment with genuinely new information (new PR link, concrete resolution, or addressing different feedback).

## Sign-off

Every comment/review MUST end with `-- TEAM/AGENT-NAME`.
