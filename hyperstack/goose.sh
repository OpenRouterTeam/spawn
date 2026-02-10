#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/lib/common.sh)"
fi

log_info "Goose on Hyperstack"
echo ""

# Authenticate with Hyperstack
ensure_hyperstack_api_key
ensure_ssh_key

# Get VM configuration
VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)

# Create VM
create_vm "$VM_NAME" "$ENVIRONMENT"
verify_server_connectivity "$HYPERSTACK_VM_IP"

log_warn "Setting up Hyperstack VM..."

# Install Goose
log_warn "Installing Goose..."
run_server "$HYPERSTACK_VM_IP" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_server "$HYPERSTACK_VM_IP" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_error "Goose installation verification failed"
    log_error "The 'goose' command is not available or not working properly"
    exit 1
fi
log_info "Goose installation verified successfully"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$HYPERSTACK_VM_IP" upload_file run_server \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Hyperstack VM setup completed successfully!"
echo ""

# Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "$HYPERSTACK_VM_IP" "source ~/.zshrc && goose"
