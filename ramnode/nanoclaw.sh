#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ramnode/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/lib/common.sh)"
fi

log_info "🐾 Spawn a NanoClaw agent on RamNode Cloud"
echo ""

# 1. Resolve RamNode credentials
ensure_ramnode_credentials

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${RAMNODE_SERVER_IP}"
wait_for_cloud_init "${RAMNODE_SERVER_IP}" 60

# 5. Install Node.js dependencies
log_step "Installing Node.js dependencies..."
run_server "${RAMNODE_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && command -v tsx || npm install -g tsx"

# 6. Clone nanoclaw
log_step "Cloning nanoclaw..."
run_server "${RAMNODE_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${RAMNODE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Create nanoclaw .env file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${RAMNODE_SERVER_IP}" "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "${RAMNODE_SERVER_IP}" "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "RamNode server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${RAMNODE_SERVER_ID}, IP: ${RAMNODE_SERVER_IP})"
echo ""

# 9. Start nanoclaw
log_step "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "${RAMNODE_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
