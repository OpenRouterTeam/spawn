# Refactor: Cloud Adapter + Agent Runner System

## Context

149 agent scripts across 11 clouds share ~70% identical boilerplate (auth, SSH key, provision, wait, API key). Only the agent-specific parts differ (install, env vars, config, launch). The refactor introduces a standard `cloud_*` adapter interface and a `spawn_agent` runner that eliminates this duplication.

## Architecture

### 1. Cloud Adapter Interface (added to each `{cloud}/lib/common.sh`)

Every cloud adds 7 standard functions at the bottom of its `lib/common.sh`. These bind cloud-specific globals (IP, sandbox ID, sprite name) so callers never need to know them:

```bash
cloud_authenticate()     # Ensure creds + SSH key (if applicable)
cloud_provision(name)    # Create server, set internal globals
cloud_wait_ready()       # Wait for connectivity + cloud-init
cloud_run(cmd)           # Execute command on server
cloud_upload(local, remote)  # Upload file to server
cloud_interactive(cmd)   # Start interactive session
cloud_label()            # Return display name string
```

**SSH-based clouds** (hetzner, digitalocean, gcp, aws-lightsail, oracle, ovh) — thin wrappers:
```bash
cloud_run()    { run_server "${HETZNER_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${HETZNER_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${HETZNER_SERVER_IP}" "$1"; }
```

**CLI-based clouds** (fly, daytona, sprite) — delegate to their CLI wrappers:
```bash
cloud_run()    { run_server "$1"; }        # fly/daytona: no IP arg
cloud_run()    { run_sprite "${SPRITE_NAME}" "$1"; }  # sprite
```

**Local** — no-ops for provision/wait:
```bash
cloud_provision() { :; }
cloud_wait_ready() { :; }
cloud_run()    { eval "$1"; }
```

### 2. `spawn_agent` Runner (added to `shared/common.sh`)

~60 lines. Orchestrates the common flow, calling agent-defined hooks where needed:

```bash
spawn_agent() {
    local agent_key="$1"

    # 1. Authenticate cloud
    cloud_authenticate

    # 2. Pre-provision prompts (github auth if agent wants it)
    if _fn_exists agent_pre_provision; then agent_pre_provision; fi

    # 3. Provision
    local server_name
    server_name=$(get_server_name)
    cloud_provision "${server_name}"

    # 4. Wait for readiness
    cloud_wait_ready

    # 5. Install agent (hook or default)
    if _fn_exists agent_install; then
        agent_install
    fi

    # 6. Get API key
    get_or_prompt_api_key

    # 7. Model selection (if agent needs it)
    if [[ -n "${AGENT_MODEL_PROMPT:-}" ]]; then
        MODEL_ID=$(get_model_id_interactive "${AGENT_MODEL_DEFAULT:-openrouter/auto}" "${agent_key}")
    fi

    # 8. Inject env vars (hook provides the vars)
    _spawn_inject_env_vars

    # 9. Agent-specific config (optional hook)
    if _fn_exists agent_configure; then agent_configure; fi

    # 10. Save connection info (optional hook)
    if _fn_exists agent_save_connection; then agent_save_connection; fi

    # 11. Pre-launch (optional hook, e.g., start gateway daemon)
    if _fn_exists agent_pre_launch; then agent_pre_launch; fi

    # 12. Launch
    local launch_cmd
    launch_cmd=$(agent_launch_cmd)
    launch_session "$(cloud_label)" cloud_interactive "${launch_cmd}"
}
```

Helper for env injection — uses `cloud_run`/`cloud_upload` directly:
```bash
_spawn_inject_env_vars() {
    log_step "Setting up environment variables..."
    local env_temp; env_temp=$(mktemp)
    chmod 600 "${env_temp}"; track_temp_file "${env_temp}"
    agent_env_vars > "${env_temp}"   # Hook: agent defines this
    cloud_upload "${env_temp}" "/tmp/env_config"
    cloud_run "cat /tmp/env_config >> ~/.bashrc && cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
    offer_github_auth cloud_run
}
```

`_fn_exists` helper (bash 3.2 compatible):
```bash
_fn_exists() { type "$1" 2>/dev/null | head -1 | grep -q 'function'; }
```

### 3. Agent Script Pattern (after refactor)

**Simple agent** — e.g., `hetzner/aider.sh` (was 37 lines → ~25 lines):
```bash
#!/bin/bash
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

log_info "Aider on Hetzner Cloud"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "Aider" "pip install aider-chat 2>/dev/null || pip3 install aider-chat" cloud_run
    verify_agent "Aider" "command -v aider && aider --version" "pip install aider-chat" cloud_run
}
agent_env_vars() { generate_env_config "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"; }
agent_launch_cmd() { printf 'source ~/.zshrc && aider --model openrouter/%s' "${MODEL_ID}"; }

spawn_agent "Aider"
```

**Complex agent** — e.g., `hetzner/claude.sh`:
```bash
agent_pre_provision() { prompt_github_auth; }
agent_install() { install_claude_code cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
        "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=" \
        "CLAUDE_CODE_SKIP_ONBOARDING=1" \
        "CLAUDE_CODE_ENABLE_TELEMETRY=0"
}
agent_configure() { setup_claude_code_config "${OPENROUTER_API_KEY}" cloud_upload cloud_run; }
agent_launch_cmd() { echo 'source ~/.bashrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude'; }

spawn_agent "Claude Code"
```

**Edge-case agent** — e.g., `hetzner/openclaw.sh` (needs gateway daemon):
```bash
agent_pre_launch() {
    cloud_run "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
    sleep 2
}
```

**Cross-cloud portability**: An agent's hooks are identical across all clouds. Only the source line at the top changes (e.g., `hetzner/lib/common.sh` → `fly/lib/common.sh`).

### 4. Special Cases

**Sprite `SPAWN_PROMPT`**: Handled in `cloud_interactive()` — Sprite's adapter checks `SPAWN_PROMPT` and uses non-tty exec if set.

**OVH no cloud-init**: OVH's `cloud_wait_ready()` calls `install_base_deps` instead of `wait_for_cloud_init`.

**Local (no provisioning)**: `cloud_provision()` and `cloud_wait_ready()` are no-ops. `cloud_run` uses `eval`. Local agent scripts still use `spawn_agent` — it just skips provisioning steps naturally.

**`save_vm_connection`**: Clouds that need it (digitalocean, sprite) call it from `cloud_provision()` or a post-provision hook.

## Files to Modify

### Core (2 files)
- `shared/common.sh` — Add `spawn_agent()`, `_spawn_inject_env_vars()`, `_fn_exists()`

### Cloud Adapters (11 files)
- `hetzner/lib/common.sh` — Add `cloud_*` functions wrapping `run_server $HETZNER_SERVER_IP` etc.
- `digitalocean/lib/common.sh` — Same, wrapping `$DO_SERVER_IP`
- `gcp/lib/common.sh` — Same, wrapping `$GCP_SERVER_IP`
- `aws-lightsail/lib/common.sh` — Same, wrapping `$LIGHTSAIL_SERVER_IP`
- `oracle/lib/common.sh` — Same, wrapping `$OCI_SERVER_IP`
- `ovh/lib/common.sh` — Same, wrapping `$OVH_SERVER_IP`, also `cloud_wait_ready()` calls `install_base_deps`
- `fly/lib/common.sh` — Same, no IP arg
- `daytona/lib/common.sh` — Same, no IP arg
- `sprite/lib/common.sh` — Same, wrapping `$SPRITE_NAME`, handles `SPAWN_PROMPT` in `cloud_interactive`
- `local/lib/common.sh` — No-op provision/wait, `eval` for run

### Agent Scripts (~149 files)
All `{cloud}/{agent}.sh` files get rewritten to use the hook pattern + `spawn_agent`. Each shrinks from ~40-80 lines to ~20-35 lines.

## Execution Strategy

Use a team of agents working in parallel:
1. **Agent 1**: Add `spawn_agent` + `_fn_exists` + `_spawn_inject_env_vars` to `shared/common.sh`
2. **Agent 2**: Add `cloud_*` adapter functions to all 11 cloud `lib/common.sh` files
3. **Agents 3-5**: Convert agent scripts (split by cloud groups)
4. **Agent 6**: Run `bash -n` on all files + run test suite

Work sequentially: core first (1+2), then scripts (3-5), then verify (6).

## Verification

1. `bash -n` syntax check on every modified `.sh` file
2. `bash test/run.sh` — full mock test suite
3. Spot-check: read 5-6 converted scripts to verify hook pattern is correct
4. Verify `curl|bash` compatibility — source fallback pattern preserved in all files
