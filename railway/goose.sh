#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Goose on Railway"
echo ""

# Setup Railway environment
ensure_railway_cli
ensure_railway_token

# Create Railway service
SERVER_NAME=$(get_server_name "goose")
create_server "${SERVER_NAME}"
wait_for_cloud_init

# Install Goose
log_step "Installing Goose..."
run_server "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_server "command -v goose &> /dev/null && goose --version &> /dev/null"; then
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

# Inject environment variables
inject_env_vars \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Railway service setup completed successfully!"
echo ""

# Start Goose interactively
log_step "Starting Goose..."
sleep 1
clear
interactive_session "bash -c 'source ~/.bashrc && goose'"
