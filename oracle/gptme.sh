#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/oracle/lib/common.sh)"
fi

log_info "gptme on Oracle Cloud Infrastructure"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "gptme" "pip install gptme 2>/dev/null || pip3 install gptme" cloud_run
    verify_agent "gptme" "command -v gptme && gptme --version" "pip install gptme" cloud_run
}
agent_env_vars() { generate_env_config "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"; }
agent_launch_cmd() { printf 'source ~/.zshrc && gptme -m openrouter/%s' "${MODEL_ID}"; }

spawn_agent "gptme"
