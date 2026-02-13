#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlanticnet/lib/common.sh)"
fi

log_info "Goose on Atlantic.Net Cloud"
echo ""

# Authenticate with Atlantic.Net
ensure_atlanticnet_credentials

# Setup SSH key
ensure_ssh_key

# Get or prompt for server name
SERVER_NAME=$(get_server_name)

# Create server
create_server "${SERVER_NAME}"

# Wait for SSH connectivity
log_step "Waiting for server to be ready..."
verify_server_connectivity "${ATLANTICNET_SERVER_IP}"

log_step "Setting up server environment..."

# Install Goose
log_step "Installing Goose..."
run_server "${ATLANTICNET_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_server "${ATLANTICNET_SERVER_IP}" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_install_failed "Goose" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash" "${ATLANTICNET_SERVER_IP}"
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

log_step "Setting up environment variables..."
inject_env_vars_ssh "${ATLANTICNET_SERVER_IP}" upload_file run_server \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Server setup completed successfully!"
echo ""

# Start interactive session
log_step "Starting Goose..."
sleep 1
clear
interactive_session "${ATLANTICNET_SERVER_IP}" "source ~/.bashrc && goose"
