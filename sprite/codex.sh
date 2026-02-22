#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "Codex CLI on Sprite"
echo ""

agent_install() {
    install_agent "Codex CLI" "export PATH=\$(npm prefix -g 2>/dev/null)/bin:\$PATH && npm install -g @openai/codex" cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}

agent_configure() {
    setup_codex_config "${OPENROUTER_API_KEY}" cloud_upload cloud_run
}

agent_launch_cmd() {
    echo 'source ~/.spawnrc 2>/dev/null; export PATH=$(npm prefix -g 2>/dev/null)/bin:$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH; codex'
}

spawn_agent "Codex CLI" "codex" "sprite"
