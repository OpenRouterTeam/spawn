#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=aws/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"
fi

log_info "Aider on AWS Lightsail"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "Aider" "python3 -m pip install pipx && pipx install aider-chat" cloud_run
    verify_agent "Aider" "command -v aider && aider --version" "pipx install aider-chat" cloud_run
}
agent_env_vars() { generate_env_config "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"; }
agent_launch_cmd() { printf 'source ~/.zshrc && aider --model openrouter/%s' "${MODEL_ID}"; }

spawn_agent "Aider"
