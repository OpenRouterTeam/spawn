#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hetzner/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

log_info "OpenClaw on Hetzner Cloud"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() { install_agent "openclaw" "source ~/.bashrc && bun install -g openclaw" cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
}
agent_configure() { setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" cloud_upload cloud_run; }
agent_pre_launch() {
    cloud_run "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 </dev/null & disown"
    wait_for_openclaw_gateway cloud_run
}
agent_launch_cmd() { echo 'source ~/.zshrc && openclaw tui'; }

spawn_agent "OpenClaw"
