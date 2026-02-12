#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/latitude/lib/common.sh)"
fi

log_info "NanoClaw on Latitude.sh"
echo ""

# 1. Resolve Latitude.sh API token
ensure_latitude_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for server to become active and get IP
wait_for_server_ready "${LATITUDE_SERVER_ID}" 60

# 5. Wait for SSH connectivity
verify_server_connectivity "${LATITUDE_SERVER_IP}"

# 6. Install base tools and nanoclaw
install_base_tools "${LATITUDE_SERVER_IP}"

log_step "Installing tsx..."
run_server "${LATITUDE_SERVER_IP}" "source ~/.bashrc && bun install -g tsx"

log_step "Cloning and building nanoclaw..."
run_server "${LATITUDE_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${LATITUDE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Create nanoclaw .env file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
track_temp_file "${DOTENV_TEMP}"
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${LATITUDE_SERVER_IP}" "${DOTENV_TEMP}" "/root/nanoclaw/.env"

echo ""
log_info "Latitude.sh server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${LATITUDE_SERVER_ID}, IP: ${LATITUDE_SERVER_IP})"
echo ""

# 9. Start nanoclaw
log_step "Starting nanoclaw..."
log_step "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "${LATITUDE_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
