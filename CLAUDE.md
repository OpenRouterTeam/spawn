# Spawn

## Culture: Embrace Bold Changes

**This is mandatory.** When a change is right, helps the user, and is tasteful — make it. Do not shy away from large-scope work.

- **Do NOT refuse work because it's "too big."** If the user asks for a codebase-wide refactor touching 50+ files, do it. Parallelize with agents. Ship it.
- **Do NOT water down scope.** If the plan says "replace all 119 `as` casts across the codebase," you replace ALL 119, not 5 with a TODO for the rest.
- **Do NOT propose half-measures.** Don't suggest "we could start with just one module" when the user wants the whole thing. The whole thing is the point.
- **Parallelize aggressively.** Use the Task tool to spawn multiple agents working on independent files simultaneously. A 50-file change should NOT be sequential.
- **Fix tests too.** If a new lint rule or code change breaks tests, fix every single test. Don't exclude test files from rules to avoid the work.
- **Verify exhaustively.** After a big change: full lint (0 errors), full test suite (0 failures), full build (succeeds). No partial checks.

Spawn is a matrix of **agents x clouds**. Every script provisions a cloud server, installs an agent, injects OpenRouter credentials, and drops the user into an interactive session.

## The Matrix

`manifest.json` is the source of truth. It tracks:
- **agents** — AI agents and self-hosted AI tools (Claude Code, OpenClaw, NanoClaw, ...)
- **clouds** — cloud providers to run them on (Sprite, Hetzner, ...)
- **matrix** — which `cloud/agent` combinations are `"implemented"` vs `"missing"`

## How to Improve Spawn

When run via `./discovery.sh`, your job is to pick ONE of these tasks and execute it:

### 1. Fill a missing matrix entry

Look at `manifest.json` → `matrix` for any `"missing"` entry. To implement it:

- Find the **agent's** existing script on another cloud — it shows the install steps, config files, env vars, and launch command
- The agent scripts are thin bash wrappers that bootstrap bun and run the TypeScript CLI
- The script goes at `{cloud}/{agent}.sh`

**OpenRouter injection is mandatory.** Every agent script MUST:
- Set `OPENROUTER_API_KEY` in the shell environment
- Set provider-specific env vars (e.g., `ANTHROPIC_BASE_URL=https://openrouter.ai/api`)
- These come from the agent's `env` field in `manifest.json`

### 2. Add a new cloud provider (HIGH BAR)

We are currently shipping with **9 curated clouds** (sorted by price):
1. **local** — free (no provisioning)
2. **hetzner** — ~€3.29/mo (CX22)
3. **ovh** — ~€3.50/mo (d2-2)
4. **fly** — free tier (3 shared-cpu VMs)
5. **aws** — $3.50/mo (nano)
6. **daytona** — pay-per-second sandboxes
7. **digitalocean** — $4/mo (Basic droplet)
8. **gcp** — $7.11/mo (e2-micro)
9. **sprite** — Fly.io managed VMs

**Do NOT add clouds speculatively.** Every cloud must be manually tested and verified end-to-end before shipping. Adding a cloud that can't be tested is worse than not having it.

**Requirements to add a new cloud:**
- **Prestige or unbeatable pricing** — must be a well-known brand OR beat our cheapest options
- **Must be manually testable** — you need an account and can verify scripts work
- **REST API or CLI with SSH/exec** — no proprietary-only access methods
- **Test coverage is mandatory** — add unit tests in `cli/src/__tests__/`

Steps to add one:
1. Add cloud-specific TypeScript module in `cli/src/{cloud}/`
2. Add an entry to `manifest.json` → `clouds`
3. Add `"missing"` entries to the matrix for every existing agent
4. Implement at least 2-3 agent scripts to prove the lib works
5. Update the cloud's `README.md`
6. **Add test coverage** (mandatory) — add unit tests in `cli/src/__tests__/`

**DO NOT add GPU clouds** (CoreWeave, RunPod, etc.). Spawn agents call remote LLM APIs for inference — they need cheap CPU instances with SSH, not expensive GPU VMs.

### 3. Add a new agent (only with community demand)

Do NOT add agents speculatively. Only add one if there's **real community buzz**:

**Required evidence (at least 2 of these):**
- 1000+ GitHub stars on the agent's repo
- Hacker News post with 50+ points (search: `https://hn.algolia.com/api/v1/search?query=AGENT_NAME`)
- Reddit post with 100+ upvotes in r/LocalLLaMA, r/MachineLearning, or r/ChatGPT
- Explicit user request in this repo's GitHub issues

**Technical requirements:**
- Installable via a single command (npm, pip, curl)
- Accepts API keys via env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`)
- Works with OpenRouter (natively or via `OPENAI_BASE_URL` override)

To add: same steps as before (manifest.json entry, matrix entries, implement on 1+ cloud, README).

### 4. Respond to GitHub issues

Check `gh issue list --repo OpenRouterTeam/spawn --state open` for user requests:
- If someone requests an agent or cloud, implement it and comment with the PR link
- If something is already implemented, close the issue with a note
- If a bug is reported, fix it

### 4. Extend tests

Tests use Bun's built-in test runner (`bun:test`). When adding a new cloud or agent:
- Add unit tests in `cli/src/__tests__/` with mocked fetch/prompts
- Run `bun test` to verify

## File Structure Convention

```
spawn/
  cli/
    src/index.ts                 # CLI entry point (bun/TypeScript)
    src/manifest.ts              # Manifest fetch + cache logic
    src/commands.ts              # All subcommands (interactive, list, run, etc.)
    src/version.ts               # Version constant
    package.json                 # npm package (@openrouter/spawn)
    install.sh                   # One-liner installer (bun → npm → auto-install bun)
  shared/
    github-auth.sh               # Standalone GitHub CLI auth helper
    key-request.sh               # API key provisioning helpers (used by QA)
  {cloud}/
    {agent}.sh                   # Agent deployment scripts (thin bash → bun wrappers)
  .claude/skills/setup-agent-team/
    trigger-server.ts            # HTTP trigger server (concurrent runs, dedup)
    discovery.sh                 # Discovery cycle script (fill gaps, scout new clouds/agents)
    refactor.sh                  # Dual-mode cycle script (issue fix or full refactor)
    start-discovery.sh           # Launcher with secrets (gitignored)
    start-refactor.sh            # Launcher with secrets (gitignored)
  .github/workflows/
    discovery.yml                # Scheduled + issue-triggered discovery workflow
    refactor.yml                 # Scheduled + issue-triggered refactor workflow
  manifest.json                  # The matrix (source of truth)
  discovery.sh                   # Run this to trigger one discovery cycle
  test/fixtures/                 # API response fixtures for testing
  README.md                      # User-facing docs
  CLAUDE.md                      # This file - contributor guide
```

## Documentation Policy

**NEVER commit documentation files to the repository.** All documentation, testing guides, implementation notes, security audits, and similar files MUST be stored in `.docs/` directory (git-ignored).

Examples of files that should NOT be committed:
- `TESTING_*.md`
- `SECURITY_AUDIT.md`
- `IMPLEMENTATION_NOTES.md`
- `TODO.md`
- Any other internal documentation files

The only documentation files allowed in the repository are:
- `README.md` (user-facing)
- `CLAUDE.md` (contributor guide)
- Cloud-specific `README.md` files in `{cloud}/README.md`

If you need to create documentation during development, write it to `.docs/` and add `.docs/` to `.gitignore`.

### Architecture

All cloud provisioning and agent setup logic lives in TypeScript under `cli/src/`. Agent scripts (`{cloud}/{agent}.sh`) are thin bash wrappers that bootstrap bun and invoke the CLI.

**`shared/github-auth.sh`** — Standalone GitHub CLI installer + OAuth login helper. Used by `cli/src/shared/agent-setup.ts` to set up `gh` on remote VMs.

**`shared/key-request.sh`** — API key provisioning helpers sourced by the QA harness (`qa.sh`) for loading cloud credentials from `~/.config/spawn/{cloud}.json`.

## Shell Script Rules

These rules are **non-negotiable** — violating them breaks remote execution for all users.

### curl|bash Compatibility
Every script MUST work when executed via `bash <(curl -fsSL URL)`:
- **NEVER** use relative paths for sourcing (`source ./lib/...`, `source ../shared/...`)
- **NEVER** rely on `$0`, `dirname $0`, or `BASH_SOURCE` resolving to a real filesystem path

### macOS bash 3.x Compatibility
macOS ships bash 3.2. All scripts MUST work on it:
- **NO** `echo -e` — use `printf` for escape sequences
- **NO** `source <(cmd)` inside `bash <(curl ...)` — use `eval "$(cmd)"` instead
- **NO** `((var++))` with `set -e` — use `var=$((var + 1))` (avoids falsy-zero exit)
- **NO** `local` keyword inside `( ... ) &` subshells — not function scope
- **NO** `set -u` (nounset) — use `${VAR:-}` for optional env var checks instead

### Conventions
- `#!/bin/bash` + `set -eo pipefail` (no `u` flag)
- Use `${VAR:-}` for all optional env var checks (`OPENROUTER_API_KEY`, cloud tokens, etc.)
- Remote fallback URL: `https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/{path}`
- All env vars documented in the cloud's README.md

### Use Bun + TypeScript for Inline Scripting — NEVER python/python3
When shell scripts need JSON processing, HTTP calls, crypto, or any non-trivial logic:
- **ALWAYS** use `bun eval '...'` or write a temp `.ts` file and `bun run` it
- **NEVER** use `python3 -c` or `python -c` for inline scripting — python is not a project dependency
- Prefer `jq` for simple JSON extraction; fall back to `bun eval` when jq is unavailable
- Pass data to bun via environment variables (e.g., `_DATA="${var}" bun eval "..."`) or temp files — never interpolate untrusted values into JS strings
- For complex operations (SigV4 signing, API calls with retries), write a heredoc `.ts` file and `bun run` it

### ESM Only — NEVER use require() or CommonJS
All TypeScript code in `cli/src/` MUST use ESM (`import`/`export`):
- **NEVER** use `require()` — always use `import` (static or dynamic `await import()`)
- **NEVER** use `module.exports` — always use `export` / `export default`
- **NEVER** use `createRequire` — it's a CJS compatibility hack that triggers Bun bugs
- The project is `"type": "module"` in `package.json` — CJS is not supported
- For Node.js built-ins: `import fs from "fs"`, `import path from "path"`, etc.
- For dynamic imports: `const mod = await import("./module.ts")`

## Type Safety — No `as` Type Assertions

**`as` type assertions are banned in all TypeScript code (production AND tests).** This is enforced by a GritQL biome plugin (`cli/no-type-assertion.grit`).

### Exemptions
- `as const` — allowed (compile-time only, no runtime risk)
- That's it. `as unknown` is also banned.

### What to use instead

**For API responses / parsed JSON — use valibot schema validation:**
```typescript
import * as v from "valibot";
import { parseJsonWith } from "../shared/parse";

// Declare schemas at module top level, not inside functions
const UserSchema = v.object({ id: v.number(), name: v.string() });

// Returns typed data or null — no `as` needed
const user = parseJsonWith(responseText, UserSchema);
```

**For loose JSON objects (many optional fields):**
```typescript
const LooseObject = v.record(v.string(), v.unknown());
function parseJson(text: string): Record<string, unknown> | null {
  return parseJsonWith(text, LooseObject);
}
```

**For narrowing `unknown` values — use type guards:**
```typescript
typeof val === "string" ? val : ""
typeof val === "number" ? val : 0
Array.isArray(val) ? val : []
```

**For array-of-objects narrowing:**
```typescript
function toObjectArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item));
}
```

**For test mocks — use proper Response objects instead of `as any`:**
```typescript
// WRONG: global.fetch = mock(() => Promise.resolve({ ok: true, json: async () => data }) as any);
// RIGHT:
global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(data))));
// For errors:
global.fetch = mock(() => Promise.resolve(new Response("Error", { status: 500 })));
```

**For type literals — use `satisfies` or typed variables:**
```typescript
// WRONG: const config = { ... } as AgentConfig;
// RIGHT: const config: AgentConfig = { ... };
// OR:    const config = { ... } satisfies AgentConfig;
```

### Shared utilities
- `cli/src/shared/parse.ts` — `parseJsonWith(text, schema)` and `parseJsonRaw(text)`
- `cli/src/shared/type-guards.ts` — `isString`, `isNumber`, `hasStatus`, `hasMessage`

## Testing

- **NEVER use vitest** — use Bun's built-in test runner (`bun:test`) exclusively
- Test files go in `cli/src/__tests__/`
- Run tests with `bun test`
- Use `import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"`
- All tests must be pure unit tests with mocked fetch/prompts — **no subprocess spawning** (`execSync`, `spawnSync`, `Bun.spawn`)
- Test fixtures (API response snapshots) go in `test/fixtures/{cloud}/`

## CLI Version Management

**CRITICAL: Bump the version on every CLI change!**

- **ANY change to `cli/` requires a version bump** in `cli/package.json`
- Use semantic versioning:
  - **Patch** (0.2.X → 0.2.X+1): Bug fixes, minor improvements, documentation
  - **Minor** (0.X.0 → 0.X+1.0): New features, significant improvements
  - **Major** (X.0.0 → X+1.0.0): Breaking changes
- The CLI has auto-update enabled — users get new versions immediately on next run
- Version bumps ensure users always have the latest fixes and features
- **NEVER commit `cli/cli.js`** — it is a build artifact (already in `.gitignore`). It is produced during releases, not checked into the repo. Do NOT use `git add -f cli/cli.js`.

## Autonomous Loops

When running autonomous discovery/refactoring loops (`./discovery.sh --loop`):

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

## Git Workflow

- Always work on a feature branch — never commit directly to main (except urgent one-line fixes)
- Before creating a PR, check `git status` and `git log` to verify branch state
- Use `gh pr create` from the feature branch, then `gh pr merge --squash`
- **Every PR must be MERGED or CLOSED with a comment** — never close silently
- If a PR can't be merged (conflicts, superseded, wrong approach), close it with `gh pr close {number} --comment "Reason"`
- Never rebase main or use `--force` unless explicitly asked

### Draft PR First — MANDATORY

**NEVER make changes without opening a PR.** Every change MUST go through a draft PR:

1. **Create a branch and commit immediately** after the first meaningful change
2. **Open a draft PR right away** — `gh pr create --draft` after your first commit
3. **Push incremental commits** as you work — small, frequent commits are better than one big one
4. **Convert to non-draft when done** — `gh pr ready NUMBER`

This applies to ALL work — features, bug fixes, refactors, test additions, config changes. No exceptions. If code was changed, there must be a PR for it.

Draft PRs that go stale (no updates for 1 week) will be auto-closed.

## After Each Change

1. `bash -n {file}` syntax check on all modified scripts
2. `cd cli && bunx @biomejs/biome lint src/` — **must pass with zero errors** on all modified TypeScript
3. Update `manifest.json` matrix status to `"implemented"`
4. Update the cloud's `README.md` with usage instructions
5. Commit with a descriptive message

## Filing Issues for Discovered Problems

When you encounter bugs, stale references, broken functionality, or architectural issues that are **outside the scope of your current task**, file a GitHub issue immediately rather than ignoring them or trying to fix everything at once:

```bash
gh issue create --repo OpenRouterTeam/spawn --title "bug: <brief description>" --body "<details>"
```

Examples of when to file:
- Dead code or stale references to files/functions that no longer exist
- Broken features (e.g., `spawn delete` references non-existent shell scripts)
- Security concerns that need separate review
- Architectural debt that would be too large to fix in the current PR

**Do NOT silently ignore problems.** If you find something weird and won't fix it now, file an issue so it's tracked.
