#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=atlanticnet/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlanticnet/lib/common.sh)"
fi

log_info "NanoClaw on Atlantic.Net Cloud"
echo ""

# 1. Resolve Atlantic.Net API credentials
ensure_atlanticnet_credentials

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH connectivity
verify_server_connectivity "${ATLANTICNET_SERVER_IP}"

# 5. Install Node.js dependencies
log_step "Installing Node.js dependencies..."
run_server "${ATLANTICNET_SERVER_IP}" "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs"

# Install tsx globally
log_step "Installing tsx..."
run_server "${ATLANTICNET_SERVER_IP}" "npm install -g tsx"

# 6. Clone and build nanoclaw
log_step "Cloning and building nanoclaw..."
run_server "${ATLANTICNET_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${ATLANTICNET_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Create nanoclaw .env file
log_step "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"

upload_file "${ATLANTICNET_SERVER_IP}" "${DOTENV_TEMP}" "/root/nanoclaw/.env"

echo ""
log_info "Atlantic.Net server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${ATLANTICNET_SERVER_ID}, IP: ${ATLANTICNET_SERVER_IP})"
echo ""

# 9. Start nanoclaw interactively
log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
sleep 1
clear
interactive_session "${ATLANTICNET_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
