#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hyperstack/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/lib/common.sh)"
fi

log_info "Aider on Hyperstack"
echo ""

# 1. Resolve Hyperstack API key
ensure_hyperstack_api_key

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get VM name and environment
VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)

# 4. Create VM
create_vm "${VM_NAME}" "${ENVIRONMENT}"

# 5. Wait for SSH
verify_server_connectivity "${HYPERSTACK_VM_IP}"

# 6. Install Aider
log_warn "Installing Aider..."
run_server "${HYPERSTACK_VM_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

# Verify installation succeeded
if ! run_server "${HYPERSTACK_VM_IP}" "command -v aider &> /dev/null && aider --version &> /dev/null"; then
    log_error "Aider installation verification failed"
    log_error "The 'aider' command is not available or not working properly on VM ${HYPERSTACK_VM_IP}"
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
inject_env_vars_ssh "${HYPERSTACK_VM_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Hyperstack VM setup completed successfully!"
log_info "VM: ${VM_NAME} (ID: ${HYPERSTACK_VM_ID}, IP: ${HYPERSTACK_VM_IP})"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "${HYPERSTACK_VM_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
