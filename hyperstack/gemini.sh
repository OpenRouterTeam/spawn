#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/lib/common.sh)"
fi

log_info "Gemini CLI on Hyperstack"
echo ""

ensure_hyperstack_api_key
ensure_ssh_key

VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)

create_vm "$VM_NAME" "$ENVIRONMENT"
verify_server_connectivity "$HYPERSTACK_VM_IP"

log_warn "Installing Gemini CLI..."
run_server "$HYPERSTACK_VM_IP" "apt-get update && apt-get install -y curl && curl -fsSL https://bun.sh/install | bash"
run_server "$HYPERSTACK_VM_IP" "export BUN_INSTALL=\"\$HOME/.bun\" && export PATH=\"\$BUN_INSTALL/bin:\$PATH\" && bun install -g npm && npm install -g @google/gemini-cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
run_server "$HYPERSTACK_VM_IP" "cat >> ~/.bashrc << 'EOF'
export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
export GEMINI_API_KEY=${OPENROUTER_API_KEY}
export OPENAI_API_KEY=${OPENROUTER_API_KEY}
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
EOF"

echo ""
log_info "Hyperstack setup completed successfully!"
echo ""

log_warn "Starting Gemini..."
sleep 1
clear
interactive_session "$HYPERSTACK_VM_IP" "bash -c 'source ~/.bashrc && gemini'"
