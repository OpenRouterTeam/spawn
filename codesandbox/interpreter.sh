#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Open Interpreter on CodeSandbox"
echo ""

ensure_codesandbox_cli
ensure_codesandbox_token

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
wait_for_cloud_init

log_step "Installing Python and pip..."
run_server "apt-get update && apt-get install -y python3 python3-pip" >/dev/null 2>&1 || true

log_step "Installing Open Interpreter..."
run_server "pip3 install open-interpreter"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5183)
fi

log_step "Setting up environment variables..."
run_server 'echo "export OPENROUTER_API_KEY=\"'"${OPENROUTER_API_KEY}"'\"" >> ~/.bashrc'
run_server 'echo "export OPENAI_API_KEY=\"'"${OPENROUTER_API_KEY}"'\"" >> ~/.bashrc'
run_server 'echo "export OPENAI_BASE_URL=\"https://openrouter.ai/api/v1\"" >> ~/.bashrc'

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

log_step "Starting Open Interpreter..."
sleep 1
clear
interactive_session "source ~/.bashrc && interpreter"
