#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/latitude/lib/common.sh)"
fi

log_info "Goose on Latitude.sh"
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

# 6. Install base tools and Goose
install_base_tools "${LATITUDE_SERVER_IP}"

log_step "Installing Goose..."
run_server "${LATITUDE_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_server "${LATITUDE_SERVER_IP}" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_install_failed "Goose" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash" "${LATITUDE_SERVER_IP}"
    exit 1
fi
log_info "Goose installation verified successfully"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${LATITUDE_SERVER_IP}" upload_file run_server \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Latitude.sh server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${LATITUDE_SERVER_ID}, IP: ${LATITUDE_SERVER_IP})"
echo ""

# 8. Start Goose interactively
log_step "Starting Goose..."
sleep 1
clear
interactive_session "${LATITUDE_SERVER_IP}" "source ~/.zshrc && goose"
