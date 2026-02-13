#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Cline on Local Machine"
echo ""

ensure_local_ready

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

log_step "Installing Cline..."
if ! command -v npm &>/dev/null; then
    log_error "npm is required but not installed. Please install Node.js and npm first."
    exit 1
fi
npm install -g cline

# Verify installation
if ! command -v cline &>/dev/null; then
    log_error "Cline installation failed"
    log_error "The 'cline' command is not available"
    log_error "Try installing manually: npm install -g cline"
    exit 1
fi
log_info "Cline installation verified"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Local setup completed successfully!"
echo ""

# Start Cline
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Cline with prompt..."
    source ~/.zshrc 2>/dev/null || true
    cline "${SPAWN_PROMPT}"
else
    log_step "Starting Cline..."
    sleep 1
    clear 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec cline
fi
