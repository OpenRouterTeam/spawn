#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "NanoClaw on local machine"
echo ""

agent_install() {
    log_step "Installing tsx..."
    cloud_run "command -v bun &>/dev/null && bun install -g tsx || npm install -g tsx"
    log_step "Cloning and building nanoclaw..."
    cloud_run "test -d ~/nanoclaw || (git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build)"
    log_info "NanoClaw installed"
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
}

agent_configure() {
    local dotenv_content
    dotenv_content=$(printf 'ANTHROPIC_API_KEY=%s\nANTHROPIC_BASE_URL=https://openrouter.ai/api\n' "${OPENROUTER_API_KEY}")
    upload_config_file cloud_upload cloud_run "${dotenv_content}" "\$HOME/nanoclaw/.env"
}

agent_launch_cmd() {
    echo 'cd ~/nanoclaw && source ~/.zshrc 2>/dev/null; npm run dev'
}

agent_pre_launch() {
    log_info "You will need to scan a WhatsApp QR code to authenticate."
    echo ""
}

spawn_agent "NanoClaw"
