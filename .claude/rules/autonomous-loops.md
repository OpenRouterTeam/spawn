# Autonomous Loops

When running autonomous discovery/refactoring loops (`.claude/skills/setup-agent-team/discovery.sh --loop`):

- **Run `bash -n` on every changed .sh file** before committing — syntax errors break everything
- **NEVER revert a prior fix** — don't undo previously applied compatibility fixes
- **NEVER re-introduce deleted functions** — if a function was removed, don't call it
- **Test after EACH iteration** — don't batch multiple changes without verification
- **If a change breaks tests, STOP** — revert and ask for guidance rather than compounding the regression

## Refactoring Service

The automated refactoring service runs via `.claude/skills/setup-agent-team/`. It is triggered by GitHub Actions (on schedule, on issue open, or manual dispatch).

### Architecture

```
trigger-server.ts   — HTTP server (port 8080), spawns refactor.sh per trigger
start-refactor.sh   — Sets env vars (secrets, MAX_CONCURRENT), execs trigger-server
refactor.sh         — Dual-mode: issue fix or full refactor cycle
refactor.yml        — GitHub Actions workflow that POSTs to the trigger server
```

### Dual-Mode Cycles

`refactor.sh` detects its mode from the `SPAWN_ISSUE` env var (set by trigger-server.ts):

| | Issue Mode | Refactor Mode |
|---|---|---|
| **Trigger** | `?reason=issues&issue=N` | `?reason=schedule` |
| **Teammates** | 2 (issue-fixer, issue-tester) | 6 (security, ux, complexity, test, branch, community) |
| **Prompt timeout** | 15 min | 30 min |
| **Hard timeout** | 20 min | 40 min |
| **Worktree** | `/tmp/spawn-worktrees/issue-N/` | `/tmp/spawn-worktrees/refactor/` |
| **Team name** | `spawn-issue-N` | `spawn-refactor` |
| **Pre-cycle cleanup** | Skip | Branch/PR/worktree cleanup |
| **Post-cycle commit** | Skip (uses PR workflow) | Direct commit to main |

### Concurrency

- `MAX_CONCURRENT=3` allows 1 refactor + 2 issue runs simultaneously
- Each run gets an isolated worktree — no cross-contamination
- Cleanup only touches its own worktree, never `rm -rf /tmp/spawn-worktrees`
- Duplicate issue triggers (same issue number already running) return **409 Conflict**
- Capacity full returns **429 Too Many Requests**

### Modifying the Service

- `start-refactor.sh` is **gitignored** (contains `TRIGGER_SECRET`) — edit locally only
- `trigger-server.ts` and `refactor.sh` are committed — changes require a PR
- After merging changes, restart the service for them to take effect
- The refactor prompt uses `WORKTREE_BASE_PLACEHOLDER` which gets `sed`-substituted at runtime
- Issue prompt uses heredoc variable expansion directly (not single-quoted)
