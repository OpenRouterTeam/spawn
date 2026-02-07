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

## Script Conventions

- `#!/bin/bash` + `set -e`
- Source `lib/common.sh` with local-first, remote-fallback pattern
- Use `OPENROUTER_API_KEY` env var to skip OAuth when set
- All env vars documented in README.md under the relevant section
- Remote fallback URL: `https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/{path}`
- Scripts must be runnable via: `bash <(curl -fsSL https://openrouter.ai/lab/spawn/{cloud}/{agent}.sh)`

## After Each Change

1. Update `manifest.json` matrix status to `"implemented"`
2. Update `README.md` with usage instructions
3. Run `bash test/run.sh` if tests exist for the cloud
4. Commit with a descriptive message
