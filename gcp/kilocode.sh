#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=gcp/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/gcp/lib/common.sh)"
fi

log_info "Kilo Code on GCP Compute Engine"
echo ""

agent_install() { install_agent "Kilo Code" "npm install -g @kilocode/cli" cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "KILO_PROVIDER_TYPE=openrouter" \
        "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}"
}
agent_launch_cmd() { echo 'source ~/.zshrc && kilocode'; }

spawn_agent "Kilo Code"
