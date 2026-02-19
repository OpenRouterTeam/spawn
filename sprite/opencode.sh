#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "OpenCode on Sprite"
echo ""

agent_install() {
    install_agent "OpenCode" "$(opencode_install_cmd)" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_launch_cmd() {
    echo 'source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH; opencode'
}

spawn_agent "OpenCode"
