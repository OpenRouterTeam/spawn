---
name: pcl
description: Delete stale git branches (local + remote) that have no open PR, and prune worktrees.
argument-hint: "[--dry-run]"
allowed-tools: Bash
---

# Cleanup Stale Branches

Delete local and remote git branches that no longer have an open PR, and prune stale worktrees.

## Arguments

- `--dry-run` — List what would be deleted without actually deleting anything.

**$ARGUMENTS**

## Procedure

### Step 1: Checkout main branch

Switch to main and update to latest:

```bash
git checkout main
git pull --rebase origin main
```

**Critical:** This ensures we're not on a branch that's about to be deleted, and that we're working from the latest main.

### Step 2: Fetch and prune remote refs

```bash
git fetch --prune origin
```

### Step 3: Identify stale remote branches

List all remote branches except `main` and `HEAD`:

```bash
git branch -r --format='%(refname:short) %(committerdate:relative)' | grep -v 'origin/main\|origin/HEAD\|^origin '
```

### Step 4: Get branches with open PRs (protected)

```bash
gh pr list --repo OpenRouterTeam/spawn --state open --json headRefName --jq '.[].headRefName'
```

Any branch with an open PR MUST be skipped. Never delete a branch that has an open PR.

### Step 5: Delete stale remote branches

For each remote branch that is NOT in the open PR list:

```bash
git push origin --delete BRANCH_NAME
```

If `--dry-run` was passed, print `[dry-run] would delete origin/BRANCH_NAME` instead.

### Step 6: Delete stale local branches

List local branches (excluding the current branch and `main`):

```bash
git branch --list | grep -v '^\*' | grep -v '^ *main$' | tr -d ' '
```

For each, check if it's already merged into main or has no remote:

```bash
git branch -d BRANCH_NAME 2>/dev/null || git branch -D BRANCH_NAME
```

If `--dry-run`, print `[dry-run] would delete local BRANCH_NAME` instead.

### Step 7: Prune worktrees

```bash
git worktree prune
```

Remove any leftover worktree directories:

```bash
rm -rf /tmp/spawn-worktrees 2>/dev/null || true
```

### Step 8: Verify final state

Ensure we're on main branch:

```bash
git branch --show-current
```

Should output: `main`

### Step 9: Summary

Print a summary:
- Number of remote branches deleted
- Number of local branches deleted
- Number of branches skipped (had open PRs)
- Worktree prune status
