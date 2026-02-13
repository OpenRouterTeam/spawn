#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Goose on CodeSandbox"
echo ""

# Setup CodeSandbox environment
ensure_codesandbox_cli
ensure_codesandbox_token

SANDBOX_NAME=$(get_server_name)
create_server "${SANDBOX_NAME}"
wait_for_cloud_init

# Install Goose
log_step "Installing Goose..."
run_server "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
log_step "Verifying Goose installation..."
if ! run_server "command -v goose && goose --version"; then
    log_error "Goose installation verification failed"
    log_error "The 'goose' command is not available or not working properly"
    exit 1
fi
log_info "Goose installation verified successfully"

# Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_server "echo 'export GOOSE_PROVIDER=openrouter' >> ~/.bashrc"
run_server "echo 'export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' >> ~/.bashrc"

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

# Start Goose interactively
log_step "Starting Goose..."
sleep 1
interactive_session "source ~/.bashrc && goose"
