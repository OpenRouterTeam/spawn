#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hyperstack/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/lib/common.sh)"
fi

log_info "OpenCode on Hyperstack"
echo ""

ensure_hyperstack_api_key
ensure_ssh_key

VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)
create_vm "${VM_NAME}" "${ENVIRONMENT}"
verify_server_connectivity "${HYPERSTACK_VM_IP}"

log_warn "Installing OpenCode..."
run_server "${HYPERSTACK_VM_IP}" "$(opencode_install_cmd)"
log_info "OpenCode installed"

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

log_warn "Starting OpenCode..."
sleep 1
clear
interactive_session "${HYPERSTACK_VM_IP}" "source ~/.zshrc && opencode"
