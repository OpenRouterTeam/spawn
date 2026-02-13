#!/bin/bash
set -eo pipefail

# Source cloud-specific functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "gptme on CodeSandbox"
echo ""

# Ensure CodeSandbox CLI and token
ensure_codesandbox_cli
ensure_codesandbox_token

# Get sandbox name and create it
SANDBOX_NAME=$(get_server_name)
create_server "${SANDBOX_NAME}"

# Install Bun and set up environment
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

# Get OpenRouter API key (env var or OAuth)
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

# Inject environment variables
log_step "Setting up environment variables..."
run_server "echo 'export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' >> ~/.bashrc"

echo ""
log_info "CodeSandbox setup completed successfully!"
echo ""

# Start gptme interactively
log_step "Starting gptme..."
sleep 1
clear
interactive_session "bash -c 'source ~/.bashrc && gptme -m openrouter/${MODEL_ID}'"
