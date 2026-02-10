#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/northflank/lib/common.sh)"
fi

log_info "Goose on Northflank"
echo ""

# Setup Northflank environment
ensure_northflank_cli
ensure_northflank_token

PROJECT_NAME=$(get_project_name)
SERVICE_NAME=$(get_server_name)

# Create and configure service
create_server "${SERVICE_NAME}"
wait_for_cloud_init

# Install Goose
log_warn "Installing Goose..."
run_server "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_server "command -v goose && goose --version"; then
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
inject_env_vars_northflank \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Northflank setup completed successfully!"
echo ""

# Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "source ~/.bashrc && goose"
