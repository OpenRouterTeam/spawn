# Spawn

Spawn is a matrix of **agents x clouds**. Every script provisions a cloud server, installs an agent, injects OpenRouter credentials, and drops the user into an interactive session.

## The Matrix

`manifest.json` is the source of truth. It tracks:
- **agents** — AI agents and self-hosted AI tools (Claude Code, OpenClaw, NanoClaw, ...)
- **clouds** — cloud providers to run them on (Sprite, Hetzner, ...)
- **matrix** — which `cloud/agent` combinations are `"implemented"` vs `"missing"`

## How to Improve Spawn

When run via `./improve.sh`, your job is to pick ONE of these tasks and execute it:

### 1. Fill a missing matrix entry

Look at `manifest.json` → `matrix` for any `"missing"` entry. To implement it:

- Find the **cloud's** `lib/common.sh` — it has all the provider-specific primitives (create server, run command, upload file, interactive session)
- Find the **agent's** existing script on another cloud — it shows the install steps, config files, env vars, and launch command
- Combine them: use the cloud's primitives to execute the agent's setup steps
- The script goes at `{cloud}/{agent}.sh`

**Pattern for every script:**
```
1. Source {cloud}/lib/common.sh (local or remote fallback)
2. Authenticate with cloud provider
3. Provision server/VM
4. Wait for readiness
5. Install the agent
6. Get OpenRouter API key (env var or OAuth)
7. Inject env vars into shell config
8. Write agent-specific config files
9. Launch interactive session
```

**OpenRouter injection is mandatory.** Every agent script MUST:
- Set `OPENROUTER_API_KEY` in the shell environment
- Set provider-specific env vars (e.g., `ANTHROPIC_BASE_URL=https://openrouter.ai/api`)
- These come from the agent's `env` field in `manifest.json`

### 2. Add a new cloud provider (PRIORITY)

We bias heavily toward adding more clouds/sandboxes over more agents. To add one:

1. Create `{cloud}/lib/common.sh` with the provider's primitives:
   - Auth/token management (env var → config file → prompt)
   - Server/container creation (API call or CLI)
   - SSH/exec connectivity
   - File upload
   - Interactive session
   - Server destruction
2. Add an entry to `manifest.json` → `clouds`
3. Add `"missing"` entries to the matrix for every existing agent
4. Implement at least 2-3 agent scripts to prove the lib works
5. Update the cloud's `README.md`

**Good candidate clouds:**
- Container/sandbox platforms (fast spin-up, developer-friendly)
- GPU clouds (CoreWeave, RunPod, Vast.ai, Together AI)
- Regional providers with simple APIs (OVH, Scaleway, UpCloud)
- Any provider with REST API or CLI + SSH/exec + pay-per-hour pricing

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

`test/run.sh` contains the test harness. When adding a new cloud or agent:
- Add mock functions for the cloud's CLI/API calls
- Add per-script assertions matching the agent's setup steps
- Run `bash test/run.sh` to verify

## File Structure Convention

```
spawn/
  cli/
    src/index.ts                 # CLI entry point (bun/TypeScript)
    src/manifest.ts              # Manifest fetch + cache logic
    src/commands.ts              # All subcommands (interactive, list, run, etc.)
    src/version.ts               # Version constant
    package.json                 # npm package (@openrouter/spawn)
    install.sh                   # One-liner installer (bun → npm → bash fallback)
    spawn.sh                     # Bash fallback CLI (no bun/node required)
  shared/
    common.sh                    # Provider-agnostic shared utilities
  {cloud}/
    lib/common.sh                # Cloud-specific functions (sources shared/common.sh)
    {agent}.sh                   # Agent deployment scripts
  manifest.json                  # The matrix (source of truth)
  improve.sh                     # Run this to trigger one improvement cycle
  test/run.sh                    # Test harness
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

### Architecture: Shared Library Pattern

**`shared/common.sh`** - Core utilities used by all clouds:
- **Logging**: `log_info`, `log_warn`, `log_error` (colored output)
- **Input handling**: `safe_read` (works in interactive and piped contexts)
- **OAuth flow**: `try_oauth_flow`, `get_openrouter_api_key_oauth` (browser-based auth)
- **Network utilities**: `nc_listen` (cross-platform netcat wrapper), `open_browser`
- **SSH helpers**: `generate_ssh_key_if_missing`, `get_ssh_fingerprint`, `generic_ssh_wait`
- **Security**: `validate_model_id`, `json_escape`

**`{cloud}/lib/common.sh`** - Cloud-specific extensions:
- Sources `shared/common.sh` at the top
- Adds provider-specific functions:
  - **Sprite**: `ensure_sprite_installed`, `get_sprite_name`, `run_sprite`, etc.
  - **Hetzner**: API wrappers for server creation, SSH key management, etc.
  - **DigitalOcean**: Droplet provisioning, API calls, etc.
  - **Vultr**: Instance management via REST API
  - **Linode**: Linode-specific provisioning functions

**Agent scripts** (`{cloud}/{agent}.sh`):
1. Source their cloud's `lib/common.sh` (which auto-sources `shared/common.sh`)
2. Use shared functions for logging, OAuth, SSH setup
3. Use cloud functions for provisioning and connecting to servers
4. Deploy the specific agent with its configuration

### Why This Structure?

- **DRY principle**: OAuth, logging, SSH logic written once in `shared/common.sh`
- **Consistency**: All scripts use same authentication and error handling patterns
- **Maintainability**: Bug fixes in shared code benefit all providers automatically
- **Extensibility**: New clouds only need to implement provider-specific logic
- **Testability**: Shared functions can be tested independently

### Source Pattern

Every cloud's `lib/common.sh` starts with:

```bash
#!/bin/bash
# Cloud-specific functions for {provider}

# Source shared provider-agnostic functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../shared/common.sh" || {
    echo "ERROR: Failed to load shared/common.sh" >&2
    exit 1
}

# ... cloud-specific functions below ...
```

This pattern ensures:
- Shared utilities are always available
- Path resolution works when sourced from any location
- Script fails fast if shared library is missing

## Shell Script Rules

These rules are **non-negotiable** — violating them breaks remote execution for all users.

### curl|bash Compatibility
Every script MUST work when executed via `bash <(curl -fsSL URL)`:
- **NEVER** use relative paths for sourcing (`source ./lib/...`, `source ../shared/...`)
- **NEVER** rely on `$0`, `dirname $0`, or `BASH_SOURCE` resolving to a real filesystem path
- **ALWAYS** use the local-or-remote fallback pattern:
  ```bash
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
      source "$SCRIPT_DIR/lib/common.sh"
  else
      eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/{cloud}/lib/common.sh)"
  fi
  ```
- Similarly, `{cloud}/lib/common.sh` MUST use the same fallback for `shared/common.sh`

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

## Testing

- **NEVER use vitest** — use Bun's built-in test runner (`bun:test`) exclusively
- Test files go in `cli/src/__tests__/`
- Run tests with `bun test`
- Use `import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"`

## Autonomous Loops

When running autonomous improvement/refactoring loops (`./improve.sh --loop`):

- **Run `bash -n` on every changed .sh file** before committing — syntax errors break everything
- **NEVER revert a prior fix** — if `shared/common.sh` was changed to fix macOS compat, don't undo it
- **NEVER re-introduce deleted functions** — if `write_oauth_response_file` was removed, don't call it
- **NEVER change the source/eval fallback pattern** in lib/common.sh files — it's load-bearing for curl|bash
- **Test after EACH iteration** — don't batch multiple changes without verification
- **If a change breaks tests, STOP** — revert and ask for guidance rather than compounding the regression

## Git Workflow

- Always work on a feature branch — never commit directly to main (except urgent one-line fixes)
- Before creating a PR, check `git status` and `git log` to verify branch state
- Use `gh pr create` from the feature branch, then `gh pr merge --squash`
- **Every PR must be MERGED or CLOSED with a comment** — never close silently
- If a PR can't be merged (conflicts, superseded, wrong approach), close it with `gh pr close {number} --comment "Reason"`
- Never rebase main or use `--force` unless explicitly asked

## After Each Change

1. `bash -n {file}` syntax check on all modified scripts
2. Update `manifest.json` matrix status to `"implemented"`
3. Update the cloud's `README.md` with usage instructions
4. Commit with a descriptive message
