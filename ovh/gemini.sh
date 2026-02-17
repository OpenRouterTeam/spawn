#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ovh/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ovh/lib/common.sh)"
fi

log_info "Gemini CLI on OVHcloud"
echo ""

agent_install() { install_agent "Gemini CLI" "npm install -g @google/gemini-cli" cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "GEMINI_API_KEY=${OPENROUTER_API_KEY}" \
        "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
        "OPENAI_BASE_URL=https://openrouter.ai/api/v1"
}
agent_launch_cmd() { echo 'source ~/.zshrc && gemini'; }

spawn_agent "Gemini CLI"
