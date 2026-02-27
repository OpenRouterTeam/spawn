# Plan: Remove false-confidence `do-oauth.test.ts`

## Why
`packages/cli/src/__tests__/do-oauth.test.ts` (377 lines, ~28 tests) imports ZERO functions or constants from the DigitalOcean source module. Every test re-creates private constants inline and tests them against themselves. If the source code changes, these tests still pass — providing false confidence that is worse than having no tests.

## What
Delete `packages/cli/src/__tests__/do-oauth.test.ts` entirely.

## Anti-patterns found in this file
1. Re-implements `tokenRegex`, `codeRegex` (source has these as unexported `const`)
2. Re-implements `DO_SCOPES`, `DO_OAUTH_AUTHORIZE` (source has these as unexported `const`)
3. Re-implements `SUCCESS_HTML`/`ERROR_HTML` (source has `OAUTH_SUCCESS_HTML`/`OAUTH_ERROR_HTML` as unexported `const`)
4. Tests `JSON.stringify`/`JSON.parse` round-trips (tests Node.js builtins, not our code)
5. Tests `expect(!expiresAt).toBe(true)` where `expiresAt = undefined` (tautology)

## Dedup confirmation
- No open PRs
- Closed PRs #1986, #1977, #1975, #1967 addressed other test files but not `do-oauth.test.ts`

## Steps
1. Delete `packages/cli/src/__tests__/do-oauth.test.ts` in the worktree
2. Run `bun test` — verify all remaining tests pass
3. Run `bunx @biomejs/biome lint src/` — verify lint passes
4. Commit, push, create PR
5. Merge PR, clean up worktree

## Impact
- Removes 28 false-confidence tests (net loss in test count, net gain in test reliability)
- No production code changes
