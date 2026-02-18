#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/daytona/lib/common.sh)"
fi

log_info "Open Interpreter on Daytona"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() {
    install_agent "Open Interpreter" "command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH=\"\$HOME/.local/bin:\$PATH\" && uv tool install open-interpreter --python 3.12 --with 'setuptools<80'" cloud_run
    verify_agent "Open Interpreter" "export PATH=\"\$HOME/.local/bin:\$PATH\" && command -v interpreter" "uv tool install open-interpreter --python 3.12 --with 'setuptools<80'" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
        "OPENAI_BASE_URL=https://openrouter.ai/api/v1"
}

agent_launch_cmd() {
    printf 'export PATH="$HOME/.local/bin:$PATH"; source ~/.zshrc && interpreter --model %s --api_key %s' "${MODEL_ID}" "${OPENROUTER_API_KEY}"
}

spawn_agent "Open Interpreter"
