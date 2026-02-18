#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "Aider on Sprite"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "Aider" "command -v uv >/dev/null || { command -v brew >/dev/null && brew install uv || curl -LsSf https://astral.sh/uv/install.sh | sh; } && echo Installing aider-chat this may take a few minutes... && uv tool install --python 3.12 --upgrade aider-chat" cloud_run
    verify_agent "Aider" "export PATH=\"\$HOME/.local/bin:\$PATH\" && command -v aider" "uv tool install --python 3.12 --upgrade --reinstall aider-chat" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_launch_cmd() {
    if [[ -n "${SPAWN_PROMPT:-}" ]]; then
        local escaped; escaped=$(printf '%q' "${SPAWN_PROMPT}")
        printf 'source ~/.zshrc && aider --model openrouter/%s -m %s' "${MODEL_ID}" "${escaped}"
    else
        printf 'source ~/.zshrc && aider --model openrouter/%s' "${MODEL_ID}"
    fi
}

spawn_agent "Aider"
