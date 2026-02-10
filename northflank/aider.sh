#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=northflank/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/northflank/lib/common.sh)"
fi

log_info "Aider on Northflank"
echo ""

# 1. Ensure Northflank CLI and API token
ensure_northflank_cli
ensure_northflank_token

# 2. Get service and project names, then create service
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Aider
log_warn "Installing Aider..."
run_server "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Get model preference
echo ""
log_warn "Browse models at: https://openrouter.ai/models"
log_warn "Which model would you like to use with Aider?"
MODEL_ID=$(safe_read "Enter model ID [openrouter/auto]: ") || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# 7. Inject environment variables into shell configs
log_warn "Setting up environment variables..."

inject_env_vars_northflank \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Northflank service setup completed successfully!"
log_info "Service: ${SERVER_NAME} (Project: ${NORTHFLANK_PROJECT_NAME})"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "source ~/.bashrc && aider --model openrouter/${MODEL_ID}"
