#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Codex CLI on CodeSandbox"
echo ""

# Setup CodeSandbox environment
ensure_codesandbox_cli
ensure_codesandbox_token

SANDBOX_NAME=$(get_server_name)
create_server "${SANDBOX_NAME}"
wait_for_cloud_init

# Install Codex CLI
log_step "Installing Codex CLI..."
run_server "npm install -g @openai/codex"

# Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_server "echo 'export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_server "echo 'export OPENAI_API_KEY=${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_server "echo 'export OPENAI_BASE_URL=https://openrouter.ai/api/v1' >> ~/.bashrc"

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

# Start Codex interactively
log_step "Starting Codex..."
sleep 1
interactive_session "source ~/.bashrc && codex"
