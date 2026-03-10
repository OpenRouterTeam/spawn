# Testing

- **NEVER use vitest** — use Bun's built-in test runner (`bun:test`) exclusively
- Test files go in `packages/cli/src/__tests__/`
- Run tests with `bun test`
- Use `import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"`
- All tests must be pure unit tests with mocked fetch/prompts — **no subprocess spawning** (`execSync`, `spawnSync`, `Bun.spawn`)
- Test fixtures (API response snapshots) go in `fixtures/{cloud}/`

## Filesystem Isolation — MANDATORY

Tests MUST NEVER touch real user files. The test preload (`__tests__/preload.ts`) provides a sandbox:

- `process.env.HOME` → `/tmp/spawn-test-home-XXXX/` (isolated temp dir)
- `process.env.SPAWN_HOME` → `$HOME/.spawn` (inside sandbox)
- `process.env.XDG_CACHE_HOME` → `$HOME/.cache` (inside sandbox)

### Rules for test files:
- **NEVER import `homedir` from `node:os`** — Bun's `homedir()` ignores `process.env.HOME` and returns the real home. Use `process.env.HOME ?? ""` instead.
- **NEVER hardcode home directory paths** like `/home/user/...` or `~/...`
- **If you override `SPAWN_HOME`** in `beforeEach`, save and restore the original in `afterEach` (the preload sets a safe default)
- **Use `getUserHome()`** in production code (from `shared/ui.ts`) — it reads `process.env.HOME` first
- The `fs-sandbox.test.ts` guardrail test verifies the sandbox is active
