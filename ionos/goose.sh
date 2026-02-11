#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ionos/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ionos/lib/common.sh)"
fi

log_info "Goose on IONOS Cloud"
echo ""

# 1. Resolve IONOS credentials
ensure_ionos_credentials

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${IONOS_SERVER_IP}"
wait_for_cloud_init "${IONOS_SERVER_IP}" 60

# 5. Verify Goose is installed (fallback to manual install)
log_warn "Verifying Goose installation..."
if ! run_server "${IONOS_SERVER_IP}" "command -v goose" >/dev/null 2>&1; then
    log_warn "Goose not found, installing manually..."
    run_server "${IONOS_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
fi

# Verify installation succeeded
if ! run_server "${IONOS_SERVER_IP}" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_error "Goose installation verification failed"
    log_error "The 'goose' command is not available or not working properly on server ${IONOS_SERVER_IP}"
    exit 1
fi
log_info "Goose installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5182)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${IONOS_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "GOOSE_PROVIDER=openrouter"

echo ""
log_info "IONOS server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${IONOS_SERVER_ID}, IP: ${IONOS_SERVER_IP})"
echo ""

# 7. Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "${IONOS_SERVER_IP}" "source ~/.zshrc && goose"
