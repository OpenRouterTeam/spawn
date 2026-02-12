#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hostinger/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/lib/common.sh)"
fi

log_info "NanoClaw on Hostinger VPS"
echo ""

# 1. Resolve Hostinger API key
ensure_hostinger_token

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${HOSTINGER_VPS_IP}"
wait_for_cloud_init "${HOSTINGER_VPS_IP}" 60

# 5. Install Node.js and clone nanoclaw
log_step "Installing Node.js dependencies..."
run_server "${HOSTINGER_VPS_IP}" "bun install -g tsx"

log_step "Cloning nanoclaw..."
run_server "${HOSTINGER_VPS_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${HOSTINGER_VPS_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 7. Create nanoclaw .env file
log_step "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${HOSTINGER_VPS_IP}" "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "${HOSTINGER_VPS_IP}" "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "Hostinger VPS setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${HOSTINGER_VPS_ID}, IP: ${HOSTINGER_VPS_IP})"
echo ""

# 8. Start nanoclaw
log_step "Starting nanoclaw..."
log_step "You will need to scan a WhatsApp QR code to authenticate."
echo ""
sleep 1
clear
interactive_session "${HOSTINGER_VPS_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
