#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=digitalocean/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "OpenCode on DigitalOcean"
echo ""

agent_install() { install_agent "OpenCode" "$(opencode_install_cmd)" cloud_run; }
agent_env_vars() { generate_env_config "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"; }
agent_launch_cmd() { echo 'source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; opencode'; }

spawn_agent "OpenCode" "opencode" "digitalocean"
