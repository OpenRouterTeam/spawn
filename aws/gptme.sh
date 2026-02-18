#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"
fi

log_info "gptme on AWS Lightsail"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "gptme" "command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH=\"\$HOME/.local/bin:\$PATH\" && uv tool install gptme" cloud_run
    verify_agent "gptme" "export PATH=\"\$HOME/.local/bin:\$PATH\" && command -v gptme" "uv tool install gptme" cloud_run
}
agent_env_vars() { generate_env_config "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"; }
agent_launch_cmd() { printf 'source ~/.zshrc && gptme -m %s' "${MODEL_ID}"; }

spawn_agent "gptme"
