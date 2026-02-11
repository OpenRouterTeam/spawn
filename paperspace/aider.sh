#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=paperspace/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/paperspace/lib/common.sh)"
fi

log_info "Aider on Paperspace"
echo ""

# 1. Ensure pspace CLI is installed
ensure_pspace_installed

# 2. Resolve Paperspace API key
ensure_paperspace_api_key

# 3. Generate SSH key locally
ensure_ssh_key

# 4. Get machine name and create machine
MACHINE_NAME=$(get_machine_name)
create_machine "${MACHINE_NAME}"

# 5. Wait for SSH and system initialization
verify_server_connectivity "${PAPERSPACE_MACHINE_IP}"
wait_for_cloud_init "${PAPERSPACE_MACHINE_IP}" 120

# 6. Install Aider
log_warn "Installing Aider..."
run_server "${PAPERSPACE_MACHINE_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

# Verify installation succeeded
if ! run_server "${PAPERSPACE_MACHINE_IP}" "command -v aider &> /dev/null && aider --version &> /dev/null"; then
    log_error "Aider installation verification failed"
    log_error "The 'aider' command is not available or not working properly on machine ${PAPERSPACE_MACHINE_IP}"
    exit 1
fi
log_info "Aider installation verified successfully"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${PAPERSPACE_MACHINE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Paperspace machine setup completed successfully!"
log_info "Machine: ${MACHINE_NAME} (ID: ${PAPERSPACE_MACHINE_ID}, IP: ${PAPERSPACE_MACHINE_IP})"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "${PAPERSPACE_MACHINE_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
