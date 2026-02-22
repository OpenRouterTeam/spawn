#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=digitalocean/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "Codex CLI on DigitalOcean"
echo ""

agent_install() { install_agent "Codex CLI" "npm install -g @openai/codex" cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}
agent_configure() {
    setup_codex_config "${OPENROUTER_API_KEY}" cloud_upload cloud_run
}
agent_launch_cmd() { echo 'source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; codex'; }

spawn_agent "Codex CLI" "codex" "digitalocean"
