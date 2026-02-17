#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

log_info "Continue on Fly.io"
echo ""

agent_install() {
    install_agent "Continue CLI" "npm install -g @continuedev/cli" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_configure() {
    setup_continue_config "${OPENROUTER_API_KEY}" cloud_upload cloud_run
}

agent_launch_cmd() {
    echo 'source ~/.zshrc && cn'
}

spawn_agent "Continue"
