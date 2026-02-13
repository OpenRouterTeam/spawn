#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Plandex on CodeSandbox"
echo ""

ensure_codesandbox_cli
ensure_codesandbox_token

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
wait_for_cloud_init

log_step "Installing Plandex..."
run_server "curl -sL https://plandex.ai/install.sh | bash"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5189)
fi

log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

log_step "Starting Plandex..."
sleep 1
clear
interactive_session "source ~/.bashrc && plandex"
