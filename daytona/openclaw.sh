#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/daytona/lib/common.sh)"
fi

log_info "OpenClaw on Daytona"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "openclaw" "source ~/.bashrc && bun install -g openclaw" cloud_run
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
    # Daytona exec kills backgrounded processes when the session closes, so we
    # start the gateway inline in the same session as the TUI.
    echo 'source ~/.zshrc 2>/dev/null; source ~/.bashrc 2>/dev/null; export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH; openclaw gateway > /tmp/openclaw-gateway.log 2>&1 & for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null && break; sleep 2; done && openclaw tui'
}

spawn_agent "OpenClaw"
