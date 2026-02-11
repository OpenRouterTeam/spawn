#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=netcup/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/netcup/lib/common.sh)"
fi

log_info "Goose on Netcup Cloud"
echo ""

# 1. Resolve Netcup credentials
ensure_netcup_credentials

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${NETCUP_SERVER_IP}"
wait_for_cloud_init "${NETCUP_SERVER_IP}" 60

# 5. Install Goose
log_warn "Installing Goose..."
run_server "${NETCUP_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_server "${NETCUP_SERVER_IP}" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_error "Goose installation verification failed"
    log_error "The 'goose' command is not available or not working properly on server ${NETCUP_SERVER_IP}"
    exit 1
fi
log_info "Goose installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${NETCUP_SERVER_IP}" upload_file run_server \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Netcup VPS setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${NETCUP_SERVER_ID}, IP: ${NETCUP_SERVER_IP})"
echo ""

# 8. Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "${NETCUP_SERVER_IP}" "source ~/.zshrc && goose"
