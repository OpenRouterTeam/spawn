#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlanticnet/lib/common.sh)"
fi

log_info "Cline on Atlantic.Net Cloud"
echo ""

ensure_atlanticnet_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

log_step "Waiting for server to be ready..."
verify_server_connectivity "${ATLANTICNET_SERVER_IP}"

log_step "Installing Cline..."
run_server "${ATLANTICNET_SERVER_IP}" "npm install -g cline"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_server "${ATLANTICNET_SERVER_IP}" "cat >> ~/.bashrc << 'EOF'
export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
export OPENAI_API_KEY=${OPENROUTER_API_KEY}
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
EOF"

echo ""
log_info "Server setup completed successfully!"
echo ""

log_step "Starting Cline..."
sleep 1
clear
interactive_session "${ATLANTICNET_SERVER_IP}" "source ~/.bashrc && cline"
