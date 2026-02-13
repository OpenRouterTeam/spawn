#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Gemini CLI on CodeSandbox"
echo ""

ensure_codesandbox_cli
ensure_codesandbox_token

CODESANDBOX_SANDBOX_NAME=$(get_server_name)
create_server "${CODESANDBOX_SANDBOX_NAME}"
wait_for_cloud_init

log_step "Installing Gemini CLI..."
run_server "npm install -g @google/gemini-cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_server 'printf "export OPENROUTER_API_KEY=\"%s\"\n" "'"${OPENROUTER_API_KEY}"'" >> ~/.bashrc'
run_server 'printf "export GEMINI_API_KEY=\"%s\"\n" "'"${OPENROUTER_API_KEY}"'" >> ~/.bashrc'
run_server 'printf "export OPENAI_API_KEY=\"%s\"\n" "'"${OPENROUTER_API_KEY}"'" >> ~/.bashrc'
run_server 'printf "export OPENAI_BASE_URL=\"%s\"\n" "https://openrouter.ai/api/v1" >> ~/.bashrc'

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

log_step "Starting Gemini..."
sleep 1
clear
interactive_session "bash -lc 'gemini'"
