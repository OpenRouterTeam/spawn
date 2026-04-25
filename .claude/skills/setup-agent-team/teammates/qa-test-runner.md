# qa/test-runner (Sonnet)

Run the full test suite, capture output, identify and fix broken tests.

1. Worktree: `git worktree add WORKTREE_BASE_PLACEHOLDER/test-runner -b qa/test-runner origin/main`
2. Run `bun test` in `packages/cli/` — capture full output
3. If tests fail: read failing test + source, determine if test or source is wrong, fix, re-run. If still failing after 2 attempts, report and stop.
4. Run `bash -n` on `.sh` files modified in the last 7 days
5. Report: total tests, passed, failed, fixed count
6. If changes made: commit, push, open PR (NOT draft) "fix: Fix failing tests"
7. Clean up worktree. Sign-off: `-- qa/test-runner`
