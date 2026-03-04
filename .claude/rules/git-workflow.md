# Git Workflow

- Always work in a **git worktree** — never edit files in the main checkout
- Before creating a PR, check `git status` and `git log` to verify branch state
- Use `gh pr create` from the worktree, then `gh pr merge --squash`
- **Every PR must be MERGED or CLOSED with a comment** — never close silently
- If a PR can't be merged (conflicts, superseded, wrong approach), close it with `gh pr close {number} --comment "Reason"`
- Never rebase main or use `--force` unless explicitly asked

## Worktree-First Workflow — MANDATORY

**This is the #1 most important workflow rule.** A PreToolUse hook in `.claude/settings.json` **blocks all Write/Edit calls unless the target file is inside a git worktree**. Edits to the main checkout are always blocked.

Before editing ANY files:

1. **Create a worktree** with a feature branch:
   ```bash
   git worktree add /tmp/spawn-worktrees/FEATURE -b descriptive-branch-name
   ```
2. **Edit files using absolute paths** into the worktree:
   ```
   /tmp/spawn-worktrees/FEATURE/packages/cli/src/foo.ts   ← YES
   /home/sprite/spawn/packages/cli/src/foo.ts              ← BLOCKED
   ```
3. **Commit and push** from the worktree:
   ```bash
   git -C /tmp/spawn-worktrees/FEATURE add -A
   git -C /tmp/spawn-worktrees/FEATURE commit -m "message"
   git -C /tmp/spawn-worktrees/FEATURE push -u origin HEAD
   ```
4. **Open a draft PR, then merge when done:**
   ```bash
   gh pr create --draft --repo OpenRouterTeam/spawn
   gh pr ready NUMBER && gh pr merge --squash NUMBER
   ```
5. **Clean up** the worktree:
   ```bash
   git worktree remove /tmp/spawn-worktrees/FEATURE
   ```

**There is NO category of change exempt from this rule:**
- CLAUDE.md edits → worktree + PR
- Config file tweaks → worktree + PR
- One-line bug fixes → worktree + PR
- Test additions → worktree + PR
- Documentation updates → worktree + PR
- Manifest changes → worktree + PR

**A finished PR (tests pass, lint clean) MUST be converted from draft and merged immediately.** Do not leave completed PRs in draft state.

Draft PRs that go stale (no updates for 1 week) will be auto-closed.
