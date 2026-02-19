#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "OpenClaw on Sprite"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    # npm global prefix on sprites is under nvm — bin dir is not in default PATH
    install_agent "openclaw" "export PATH=\$(npm prefix -g 2>/dev/null)/bin:\$HOME/.bun/bin:/.sprite/languages/bun/bin:\$PATH && npm install -g openclaw && command -v openclaw" cloud_run
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

agent_pre_launch() {
    start_openclaw_gateway cloud_run
    wait_for_openclaw_gateway cloud_run
}

agent_launch_cmd() {
    echo 'source ~/.spawnrc 2>/dev/null; export PATH=$(npm prefix -g 2>/dev/null)/bin:$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH; openclaw tui'
}

spawn_agent "OpenClaw"
