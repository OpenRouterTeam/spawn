#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Aider on local machine"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "Aider" "pip install aider-chat 2>/dev/null || pip3 install aider-chat" cloud_run
    verify_agent "Aider" "command -v aider && aider --version" "pip install aider-chat" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_launch_cmd() {
    if [[ -n "${SPAWN_PROMPT:-}" ]]; then
        local escaped; escaped=$(printf '%q' "${SPAWN_PROMPT}")
        printf 'source ~/.zshrc 2>/dev/null; aider --model openrouter/%s -m %s' "${MODEL_ID}" "${escaped}"
    else
        printf 'source ~/.zshrc 2>/dev/null; aider --model openrouter/%s' "${MODEL_ID}"
    fi
}

spawn_agent "Aider"
