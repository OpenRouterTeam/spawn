#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=digitalocean/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "Plandex on DigitalOcean"
echo ""

agent_install() {
    install_agent "Plandex" "curl -sL https://plandex.ai/install.sh | bash" cloud_run
    verify_agent "Plandex" "command -v plandex && plandex version" "curl -sL https://plandex.ai/install.sh | bash" cloud_run
}
agent_env_vars() { generate_env_config "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"; }
agent_launch_cmd() { echo 'source ~/.zshrc && plandex'; }

spawn_agent "Plandex"
