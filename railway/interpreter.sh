#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Open Interpreter on Railway"
echo ""

# Setup Railway environment
ensure_railway_cli
ensure_railway_token

# Create Railway service
SERVER_NAME=$(get_server_name "interpreter")
create_server "${SERVER_NAME}"
wait_for_cloud_init

# Install Open Interpreter
log_step "Installing Open Interpreter..."
run_server "pip install open-interpreter 2>/dev/null || pip3 install open-interpreter"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Inject environment variables
inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Railway service setup completed successfully!"
echo ""

# Start Open Interpreter interactively
log_step "Starting Open Interpreter..."
sleep 1
clear
interactive_session "bash -c 'source ~/.bashrc && interpreter'"
