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

log_info "Plandex on Hyperstack"
echo ""

# 1. Resolve Hyperstack API key
ensure_hyperstack_api_key

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get VM name and create VM
VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)
create_vm "${VM_NAME}" "${ENVIRONMENT}"

# 4. Wait for SSH
verify_server_connectivity "${HYPERSTACK_VM_IP}"

# 5. Install Plandex
log_warn "Installing Plandex..."
run_server "${HYPERSTACK_VM_IP}" "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation succeeded
if ! run_server "${HYPERSTACK_VM_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
    log_error "The 'plandex' command is not available or not working properly on server ${HYPERSTACK_VM_IP}"
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
inject_env_vars_ssh "${HYPERSTACK_VM_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Hyperstack VM setup completed successfully!"
log_info "VM: ${VM_NAME} (ID: ${HYPERSTACK_VM_ID}, IP: ${HYPERSTACK_VM_IP})"
echo ""

# 7. Start Plandex interactively
log_warn "Starting Plandex..."
sleep 1
clear
interactive_session "${HYPERSTACK_VM_IP}" "source ~/.zshrc && plandex"
