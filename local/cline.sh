#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Cline on local machine"
echo ""

agent_install() {
    install_agent "Cline" "npm install -g cline" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_configure() {
    log_step "Authenticating Cline with OpenRouter..."
    cloud_run "source ~/.zshrc 2>/dev/null; cline auth -p openrouter -k \"${OPENROUTER_API_KEY}\""
}

agent_launch_cmd() {
    echo 'source ~/.zshrc 2>/dev/null; cline'
}

spawn_agent "Cline"
