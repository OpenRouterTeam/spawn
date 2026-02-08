# Spawn

Spawn is a matrix of **agents x clouds**. Every script provisions a cloud server, installs an agent, injects OpenRouter credentials, and drops the user into an interactive session.

## The Matrix

`manifest.json` is the source of truth. It tracks:
- **agents** — coding agents / AI tools (Claude Code, OpenClaw, NanoClaw, ...)
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

### 2. Add a new agent

Research coding agents, AI CLI tools, or AI-powered dev tools. To add one:

1. Add an entry to `manifest.json` → `agents` with: name, description, url, install command, launch command, and env vars needed for OpenRouter
2. Add `"missing"` entries to the matrix for every existing cloud
3. Implement the script for at least one cloud
4. Update `README.md`

**Where to find new agents:**
- GitHub trending in AI/coding categories
- OpenRouter's ecosystem
- HuggingFace agent frameworks
- CLI tools that accept `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (these work with OpenRouter via base URL override)

### 3. Add a new cloud provider

Research cloud providers with API-based provisioning. To add one:

1. Create `{cloud}/lib/common.sh` with the provider's primitives:
   - Auth/token management (env var → config file → prompt)
   - Server creation (API call or CLI)
   - SSH/exec connectivity
   - File upload
   - Interactive session
   - Server destruction
2. Add an entry to `manifest.json` → `clouds`
3. Add `"missing"` entries to the matrix for every existing agent
4. Implement at least one agent script
5. Update `README.md`

**Good candidate clouds** have:
- REST API or simple CLI for provisioning
- SSH access to the created server
- Cloud-init or similar userdata support
- Pay-per-hour pricing (so users can destroy after use)

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
- Never rebase main or use `--force` unless explicitly asked

## After Each Change

1. `bash -n {file}` syntax check on all modified scripts
2. Update `manifest.json` matrix status to `"implemented"`
3. Update the cloud's `README.md` with usage instructions
4. Commit with a descriptive message
