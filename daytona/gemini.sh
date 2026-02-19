#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/daytona/lib/common.sh)"
fi

log_info "Gemini CLI on Daytona"
echo ""

agent_install() {
    install_agent "Gemini CLI" "npm install -g @google/gemini-cli" cloud_run
}

# Gemini CLI uses Google's native API format (/v1beta/models/:streamGenerateContent),
# not the OpenAI-compatible format — cannot route through OpenRouter.
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_launch_cmd() {
    echo 'source ~/.zshrc && gemini'
}

spawn_agent "Gemini CLI"
