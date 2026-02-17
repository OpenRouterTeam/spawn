#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Amazon Q CLI on local machine"
echo ""

agent_install() {
    install_agent "Amazon Q CLI" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
        "OPENAI_BASE_URL=https://openrouter.ai/api/v1"
}

agent_launch_cmd() {
    echo 'source ~/.zshrc 2>/dev/null; q chat'
}

spawn_agent "Amazon Q"
