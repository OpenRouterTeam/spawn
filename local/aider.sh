#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Aider on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Aider if not already installed
if command -v aider &>/dev/null; then
    log_info "Aider already installed"
else
    log_step "Installing Aider..."
    pip install aider-chat 2>/dev/null || pip3 install aider-chat
fi

# Verify installation
if ! command -v aider &>/dev/null || ! aider --version &>/dev/null; then
    log_error "Aider installation failed"
    log_error "The 'aider' command is not available or not working properly"
    log_error "Try installing manually: pip install aider-chat"
    exit 1
fi
log_info "Aider installation verified"

# 3. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 4. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

# 5. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 6. Start Aider
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Aider with prompt..."
    source ~/.zshrc 2>/dev/null || true
    escaped_prompt=$(printf '%q' "${SPAWN_PROMPT}")
    aider --model "openrouter/${MODEL_ID}" -m "${escaped_prompt}"
else
    log_step "Starting Aider..."
    sleep 1
    clear 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec aider --model "openrouter/${MODEL_ID}"
fi
