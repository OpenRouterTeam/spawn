#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Cline on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Node.js if not already installed
if ! command -v node &>/dev/null; then
    log_error "Node.js is required but not installed"
    log_error "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# 3. Install Cline if not already installed
if command -v cline &>/dev/null; then
    log_info "Cline already installed"
else
    log_step "Installing Cline..."
    npm install -g cline
fi

# Verify installation
if ! command -v cline &>/dev/null; then
    log_error "Cline installation failed"
    log_error "The 'cline' command is not available"
    log_error "Try installing manually: npm install -g cline"
    exit 1
fi
log_info "Cline installation verified"

# 4. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 5. Inject environment variables
log_step "Appending environment variables to ~/.zshrc..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 6. Start Cline
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Cline with prompt..."
    source ~/.zshrc 2>/dev/null || true
    cline -p "${SPAWN_PROMPT}"
else
    log_step "Starting Cline..."
    sleep 1
    clear 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec cline
fi
