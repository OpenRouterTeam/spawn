#!/bin/bash
set -eo pipefail

# Source common functions - local or remote fallback
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/northflank/lib/common.sh)"
fi

log_info "gptme on Northflank"
echo ""

ensure_northflank_cli
ensure_northflank_token

SERVICE_NAME=$(get_server_name)
PROJECT_NAME=$(get_project_name)

create_server "${SERVICE_NAME}"
wait_for_cloud_init

log_step "Installing gptme..."
run_server "pip install gptme 2>/dev/null || pip3 install gptme"

# Verify installation
if ! run_server "command -v gptme &> /dev/null && gptme --version &> /dev/null"; then
    log_error "gptme installation verification failed"
    log_error "The 'gptme' command is not available or not working properly"
    exit 1
fi
log_info "gptme installation verified successfully"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_northflank \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Northflank service setup completed successfully!"
echo ""

log_step "Starting gptme..."
sleep 1
clear
interactive_session "source ~/.bashrc && gptme -m openrouter/${MODEL_ID}"
