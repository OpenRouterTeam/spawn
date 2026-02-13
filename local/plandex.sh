#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Plandex on Local Machine"
echo ""

# Ensure local machine is ready
ensure_local_ready

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# Install Plandex
log_step "Installing Plandex..."
run_server "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation succeeded
if ! run_server "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
    log_error "The 'plandex' command is not available or not working properly"
    exit 1
fi
log_info "Plandex installation verified successfully"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Local setup completed successfully!"
echo ""

# Check if running in non-interactive mode
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    # Non-interactive mode: execute prompt and exit
    log_step "Executing Plandex with prompt..."
    source ~/.zshrc 2>/dev/null || true
    plandex new
    plandex tell "${SPAWN_PROMPT}"
else
    # Interactive mode: start Plandex normally
    log_step "Starting Plandex..."
    sleep 1
    clear 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec plandex
fi
