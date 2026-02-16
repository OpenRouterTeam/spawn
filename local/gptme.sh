#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "gptme on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install gptme if not already installed
if command -v gptme &>/dev/null; then
    log_info "gptme already installed"
else
    log_step "Installing gptme..."
    pip install gptme 2>/dev/null || pip3 install gptme
fi

# Verify installation
if ! command -v gptme &>/dev/null; then
    log_install_failed "gptme" "pip install gptme"
    exit 1
fi
log_info "gptme installation verified"

# 3. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

# 4. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 5. Start gptme
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing gptme with prompt..."
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || true
    gptme -m "openrouter/${MODEL_ID}" "${SPAWN_PROMPT}"
else
    log_step "Starting gptme..."
    sleep 1
    clear 2>/dev/null || true
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || true
    exec gptme -m "openrouter/${MODEL_ID}"
fi
