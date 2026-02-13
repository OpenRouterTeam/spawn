#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "OpenCode on CodeSandbox"
echo ""

ensure_codesandbox_cli
ensure_codesandbox_token

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
wait_for_cloud_init

log_step "Installing OpenCode..."
run_server "curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5188)
fi

log_step "Setting up environment variables..."
run_server 'echo "export OPENROUTER_API_KEY=\"'"${OPENROUTER_API_KEY}"'\"" >> ~/.bashrc'

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

log_step "Starting OpenCode..."
sleep 1
clear
interactive_session "source ~/.bashrc && opencode"
