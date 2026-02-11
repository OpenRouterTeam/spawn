#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=cherry/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cherry/lib/common.sh)"
fi

log_info "Aider on Cherry Servers"
echo ""

# 1. Resolve Cherry Servers API token
ensure_cherry_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${CHERRY_SERVER_IP}"
wait_for_cloud_init "${CHERRY_SERVER_IP}" 60

# 5. Install Aider
log_warn "Installing Aider..."
run_server "${CHERRY_SERVER_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

# Verify installation succeeded
if ! run_server "${CHERRY_SERVER_IP}" "command -v aider &> /dev/null && aider --version &> /dev/null"; then
    log_error "Aider installation verification failed"
    log_error "The 'aider' command is not available or not working properly on server ${CHERRY_SERVER_IP}"
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

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${CHERRY_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Cherry Servers server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${CHERRY_SERVER_ID}, IP: ${CHERRY_SERVER_IP})"
echo ""

# 7. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "${CHERRY_SERVER_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
