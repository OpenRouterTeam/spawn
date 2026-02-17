#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=gcp/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/gcp/lib/common.sh)"
fi

log_info "Goose on GCP Compute Engine"
echo ""

agent_install() {
    install_agent "Goose" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash" cloud_run
    verify_agent "Goose" "command -v goose && goose --version" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash" cloud_run
}
agent_env_vars() {
    generate_env_config \
        "GOOSE_PROVIDER=openrouter" \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
}
agent_launch_cmd() { echo 'source ~/.zshrc && goose'; }

spawn_agent "Goose"
