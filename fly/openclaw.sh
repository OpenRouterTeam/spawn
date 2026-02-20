#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

log_info "OpenClaw on Fly.io"
echo ""

# OpenClaw is heavy (52 deps + native modules) — needs more resources
FLY_VM_MEMORY="${FLY_VM_MEMORY:-2048}"
FLY_VM_SIZE="${FLY_VM_SIZE:-shared-cpu-2x}"

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    # Try bun first (much faster), fall back to npm if it fails
    install_agent "openclaw" "source ~/.bashrc && { bun install -g openclaw 2>/dev/null || npm install -g openclaw@latest; }" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
}

agent_configure() {
    setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" cloud_upload cloud_run
}

agent_launch_cmd() {
    # Fly SSH kills backgrounded processes when the session closes, so we can't
    # start the gateway in agent_pre_launch (separate SSH call). Instead, start
    # it inline in the same session as the TUI.
    echo 'source ~/.zshrc && openclaw gateway > /tmp/openclaw-gateway.log 2>&1 & for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null && break; sleep 2; done && openclaw tui'
}

spawn_agent "OpenClaw"
