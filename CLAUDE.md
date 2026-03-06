# Spawn

Spawn is a matrix of **agents x clouds**. Every script provisions a cloud server, installs an agent, injects OpenRouter credentials, and drops the user into an interactive session.

## The Matrix

`manifest.json` is the source of truth. It tracks:
- **agents** — AI agents and self-hosted AI tools (Claude Code, OpenClaw, ZeroClaw, ...)
- **clouds** — cloud providers to run them on (Sprite, Hetzner, ...)
- **matrix** — which `cloud/agent` combinations are `"implemented"` vs `"missing"`

## File Structure

```
spawn/
  packages/
    cli/
      src/index.ts               # CLI entry point (bun/TypeScript)
      src/manifest.ts            # Manifest fetch + cache logic
      src/commands/              # Per-command modules (interactive, list, run, etc.)
      src/commands.ts            # Compatibility shim → re-exports from commands/
      package.json               # npm package (@openrouter/spawn)
    shared/
      src/parse.ts               # parseJsonWith(text, schema) and parseJsonObj(text)
      src/type-guards.ts         # isString, isNumber, hasStatus, hasMessage
      package.json               # npm package (@openrouter/spawn-shared)
  sh/
    cli/
      install.sh                 # One-liner installer (bun → npm → auto-install bun)
    shared/
      github-auth.sh             # Standalone GitHub CLI auth helper
      key-request.sh             # API key provisioning helpers (used by QA)
    e2e/
      lib/*.sh                   # E2E helper libraries
    test/
      macos-compat.sh            # macOS compatibility test script
    {cloud}/
      {agent}.sh                 # Agent deployment scripts (thin bash → bun wrappers)
      README.md                  # Cloud-specific usage docs
  .claude/
    rules/                       # Modular rules (auto-loaded by Claude Code)
    scripts/                     # Hook scripts (enforce-worktree, validate-file, pre-merge-check)
    skills/setup-agent-team/
      trigger-server.ts          # HTTP trigger server (concurrent runs, dedup)
      discovery.sh               # Discovery cycle script
      refactor.sh                # Dual-mode cycle script (issue fix or full refactor)
      start-discovery.sh         # Launcher with secrets (gitignored)
      start-refactor.sh          # Launcher with secrets (gitignored)
  .github/workflows/
    discovery.yml                # Scheduled + issue-triggered discovery workflow
    refactor.yml                 # Scheduled + issue-triggered refactor workflow
  manifest.json                  # The matrix (source of truth)
  discovery.sh                   # Run this to trigger one discovery cycle
  fixtures/                      # API response fixtures for testing
  README.md                      # User-facing docs
  CLAUDE.md                      # This file — project overview
```

### Architecture

All cloud provisioning and agent setup logic lives in TypeScript under `packages/cli/src/`. Agent scripts (`sh/{cloud}/{agent}.sh`) are thin bash wrappers that bootstrap bun and invoke the CLI.

**`sh/shared/github-auth.sh`** — Standalone GitHub CLI installer + OAuth login helper. Used by `packages/cli/src/shared/agent-setup.ts` to set up `gh` on remote VMs.

**`sh/shared/key-request.sh`** — API key provisioning helpers sourced by the QA harness (`qa.sh`) for loading cloud credentials from `~/.config/spawn/{cloud}.json`.

## After Each Change

1. `bash -n {file}` syntax check on all modified scripts
2. `cd packages/cli && bunx @biomejs/biome check src/` — **must pass with zero errors** (lint + format) on all modified TypeScript
3. Update `manifest.json` matrix status to `"implemented"`
4. Update the cloud's `sh/{cloud}/README.md` with usage instructions
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
