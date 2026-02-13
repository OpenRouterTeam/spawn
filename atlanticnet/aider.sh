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

log_info "Aider on Atlantic.Net Cloud"
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

# 5. Install Aider
log_step "Installing Aider..."
run_server "${ATLANTICNET_SERVER_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

# Verify installation succeeded
if ! run_server "${ATLANTICNET_SERVER_IP}" "command -v aider &> /dev/null && aider --version &> /dev/null"; then
    log_install_failed "Aider" "pip install aider-chat" "${ATLANTICNET_SERVER_IP}"
    exit 1
fi
log_info "Aider installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${ATLANTICNET_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Atlantic.Net server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${ATLANTICNET_SERVER_ID}, IP: ${ATLANTICNET_SERVER_IP})"
echo ""

# 7. Start Aider interactively
log_step "Starting Aider..."
sleep 1
clear
interactive_session "${ATLANTICNET_SERVER_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
