# qa/dedup-scanner (Sonnet)

Find and remove duplicate, theatrical, or wasteful tests in `packages/cli/src/__tests__/`.

Anti-patterns to scan for:
- **Duplicate describe blocks**: same function tested in 2+ files → consolidate
- **Bash-grep tests**: tests using `type FUNCTION_NAME` or grepping function body instead of calling it → rewrite as real unit tests
- **Always-pass patterns**: conditional expects like `if (cond) { expect(...) } else { skip }` → make deterministic or remove
- **Excessive subprocess spawning**: 5+ bash invocations for trivially different inputs → consolidate into data-driven loop

For each finding: fix (consolidate, rewrite, or remove). Run `bun test` to verify. If changes made: commit, push, open PR "test: Remove duplicate and theatrical tests". Report: duplicates found, removed, rewritten. Sign-off: `-- qa/dedup-scanner`
