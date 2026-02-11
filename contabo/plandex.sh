#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=contabo/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/contabo/lib/common.sh)"
fi

log_info "Plandex on Contabo"
echo ""

# 1. Resolve Contabo credentials
ensure_contabo_credentials

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${CONTABO_SERVER_IP}"
wait_for_cloud_init "${CONTABO_SERVER_IP}" 60

# 5. Install Plandex
log_warn "Installing Plandex..."
run_server "${CONTABO_SERVER_IP}" "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation succeeded
if ! run_server "${CONTABO_SERVER_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
    log_error "The 'plandex' command is not available or not working properly on server ${CONTABO_SERVER_IP}"
    exit 1
fi
log_info "Plandex installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${CONTABO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Contabo server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${CONTABO_INSTANCE_ID}, IP: ${CONTABO_SERVER_IP})"
echo ""

# 7. Start Plandex interactively
log_warn "Starting Plandex..."
sleep 1
clear
interactive_session "${CONTABO_SERVER_IP}" "source ~/.zshrc && plandex"
