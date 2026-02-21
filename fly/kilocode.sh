#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

log_info "Kilo Code on Fly.io"
echo ""

agent_install() {
    install_agent "Kilo Code" "npm install -g @kilocode/cli" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "KILO_PROVIDER_TYPE=openrouter" \
        "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_launch_cmd() {
    echo 'source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode'
}

spawn_agent "Kilo Code"
