#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/lib/common.sh)"
fi

log_info "Amazon Q on Hyperstack"
echo ""

ensure_hyperstack_api_key
ensure_ssh_key

VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)

create_vm "$VM_NAME" "$ENVIRONMENT"
verify_server_connectivity "$HYPERSTACK_VM_IP"

log_warn "Installing Amazon Q CLI..."
run_server "$HYPERSTACK_VM_IP" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
run_server "$HYPERSTACK_VM_IP" "printf '\nexport OPENROUTER_API_KEY=%s\nexport OPENAI_API_KEY=%s\nexport OPENAI_BASE_URL=%s\n' '$OPENROUTER_API_KEY' '$OPENROUTER_API_KEY' 'https://openrouter.ai/api/v1' >> ~/.bashrc"

echo ""
log_info "VM setup completed successfully!"
echo ""

log_warn "Starting Amazon Q..."
sleep 1
clear
interactive_session "$HYPERSTACK_VM_IP" "bash -c 'source ~/.bashrc && q chat'"
