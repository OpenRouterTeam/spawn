#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "OpenCode on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install OpenCode if not already installed
if command -v opencode &>/dev/null; then
    log_info "OpenCode already installed"
else
    log_step "Installing OpenCode..."
    curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash
    export PATH="${HOME}/.local/bin:${PATH}"
fi

# Verify installation
if ! command -v opencode &>/dev/null; then
    log_error "OpenCode installation failed"
    log_error "The 'opencode' command is not available"
    log_error "Try installing manually: curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash"
    exit 1
fi
log_info "OpenCode installation verified"

# 3. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 4. Inject environment variables
log_warn "Appending environment variables to ~/.zshrc..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 5. Start OpenCode
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing OpenCode with prompt..."
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || true
    opencode -p "${SPAWN_PROMPT}"
else
    log_step "Starting OpenCode..."
    sleep 1
    clear 2>/dev/null || true
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || true
    exec opencode
fi
