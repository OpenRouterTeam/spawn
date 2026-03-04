# Shell Script Rules

These rules are **non-negotiable** — violating them breaks remote execution for all users.

## curl|bash Compatibility
Every script MUST work when executed via `bash <(curl -fsSL URL)`:
- **NEVER** use relative paths for sourcing (`source ./lib/...`, `source ../shared/...`)
- **NEVER** rely on `$0`, `dirname $0`, or `BASH_SOURCE` resolving to a real filesystem path

## macOS bash 3.x Compatibility
macOS ships bash 3.2. All scripts MUST work on it:
- **NO** `echo -e` — use `printf` for escape sequences
- **NO** `source <(cmd)` inside `bash <(curl ...)` — use `eval "$(cmd)"` instead
- **NO** `((var++))` with `set -e` — use `var=$((var + 1))` (avoids falsy-zero exit)
- **NO** `local` keyword inside `( ... ) &` subshells — not function scope
- **NO** `set -u` (nounset) — use `${VAR:-}` for optional env var checks instead

## Conventions
- `#!/bin/bash` + `set -eo pipefail` (no `u` flag)
- Use `${VAR:-}` for all optional env var checks (`OPENROUTER_API_KEY`, cloud tokens, etc.)
- Primary script URL: `https://openrouter.ai/labs/spawn/{path}` (CDN proxy, maps to repo `sh/`, e.g., `{cloud}/{agent}.sh`)
- Fallback script URL: `https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sh/{path}`
- Version check URL: `https://github.com/OpenRouterTeam/spawn/releases/download/cli-latest/version` (GitHub release artifact)
- All env vars documented in the cloud's `sh/{cloud}/README.md`

## Use Bun + TypeScript for Inline Scripting — NEVER python/python3
When shell scripts need JSON processing, HTTP calls, crypto, or any non-trivial logic:
- **ALWAYS** use `bun eval '...'` or write a temp `.ts` file and `bun run` it
- **NEVER** use `python3 -c` or `python -c` for inline scripting — python is not a project dependency
- Prefer `jq` for simple JSON extraction; fall back to `bun eval` when jq is unavailable
- Pass data to bun via environment variables (e.g., `_DATA="${var}" bun eval "..."`) or temp files — never interpolate untrusted values into JS strings
- For complex operations (SigV4 signing, API calls with retries), write a heredoc `.ts` file and `bun run` it

## ESM Only — NEVER use require() or CommonJS
All TypeScript code in `packages/cli/src/` MUST use ESM (`import`/`export`):
- **NEVER** use `require()` — always use `import` (static or dynamic `await import()`)
- **NEVER** use `module.exports` — always use `export` / `export default`
- **NEVER** use `createRequire` — it's a CJS compatibility hack that triggers Bun bugs
- The project is `"type": "module"` in `package.json` — CJS is not supported
- For Node.js built-ins: `import fs from "fs"`, `import path from "path"`, etc.
- For dynamic imports: `const mod = await import("./module.ts")`
