#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Amazon Q CLI on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Amazon Q CLI if not already installed
if command -v q &>/dev/null; then
    log_info "Amazon Q CLI already installed"
else
    log_step "Installing Amazon Q CLI..."
    curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash
    export PATH="${HOME}/.local/bin:${PATH}"
fi

# Verify installation
if ! command -v q &>/dev/null; then
    log_install_failed "Amazon Q CLI" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"
    exit 1
fi
log_info "Amazon Q CLI installation verified"

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

# 5. Start Amazon Q chat
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Amazon Q with prompt..."
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
    q chat -p "${SPAWN_PROMPT}"
else
    log_step "Starting Amazon Q..."
    sleep 1
    clear 2>/dev/null || true
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
    exec q chat
fi
