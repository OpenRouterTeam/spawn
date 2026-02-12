#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Open Interpreter on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Open Interpreter if not already installed
if command -v interpreter &>/dev/null; then
    log_info "Open Interpreter already installed"
else
    log_step "Installing Open Interpreter..."
    pip install open-interpreter 2>/dev/null || pip3 install open-interpreter
fi

# Verify installation
if ! command -v interpreter &>/dev/null; then
    log_error "Open Interpreter installation failed"
    log_error "The 'interpreter' command is not available"
    log_error "Try installing manually: pip install open-interpreter"
    exit 1
fi
log_info "Open Interpreter installation verified"

# 3. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 4. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 5. Start Open Interpreter
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Open Interpreter with prompt..."
    source ~/.zshrc 2>/dev/null || true
    escaped_prompt=$(printf '%q' "${SPAWN_PROMPT}")
    interpreter -m "${escaped_prompt}"
else
    log_step "Starting Open Interpreter..."
    sleep 1
    clear 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec interpreter
fi
