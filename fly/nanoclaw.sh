#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

log_info "NanoClaw on Fly.io"
echo ""

agent_install() {
    log_step "Installing tsx..."
    cloud_run "source ~/.bashrc && bun install -g tsx"
    log_step "Cloning and building nanoclaw..."
    cloud_run "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
    log_info "NanoClaw installed"
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
}

agent_configure() {
    log_step "Configuring nanoclaw..."
    local dotenv_temp
    dotenv_temp=$(mktemp)
    chmod 600 "${dotenv_temp}"
    track_temp_file "${dotenv_temp}"
    printf 'ANTHROPIC_API_KEY=%s\nANTHROPIC_BASE_URL=https://openrouter.ai/api\n' "${OPENROUTER_API_KEY}" > "${dotenv_temp}"
    cloud_upload "${dotenv_temp}" "/root/nanoclaw/.env"
}

agent_launch_cmd() {
    echo 'cd ~/nanoclaw && source ~/.zshrc && npm run dev'
}

agent_pre_launch() {
    log_info "You will need to scan a WhatsApp QR code to authenticate."
    echo ""
}

spawn_agent "NanoClaw"
