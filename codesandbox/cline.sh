#!/bin/bash
set -eo pipefail

# Source cloud-specific functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Cline on CodeSandbox"
echo ""

# Ensure CodeSandbox CLI and token
ensure_codesandbox_cli
ensure_codesandbox_token

# Get sandbox name and create it
SANDBOX_NAME=$(get_server_name)
create_server "${SANDBOX_NAME}"

# Install Bun and set up environment
wait_for_cloud_init

log_step "Installing Node.js and Cline..."
run_server "npm install -g cline"

# Get OpenRouter API key (env var or OAuth)
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Inject environment variables
log_step "Setting up environment variables..."
run_server "echo 'export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_server "echo 'export OPENAI_API_KEY=${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_server "echo 'export OPENAI_BASE_URL=https://openrouter.ai/api/v1' >> ~/.bashrc"

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

# Start Cline interactively
log_step "Starting Cline..."
sleep 1
clear
interactive_session "bash -c 'source ~/.bashrc && cline'"
