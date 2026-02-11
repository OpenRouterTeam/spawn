#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Goose on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Goose if not already installed
if command -v goose &>/dev/null; then
    log_info "Goose already installed"
else
    log_warn "Installing Goose..."
    CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash
fi

# Verify installation
if ! command -v goose &>/dev/null; then
    log_error "Goose installation failed"
    log_error "The 'goose' command is not available"
    log_error "Try installing manually: CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
    exit 1
fi
log_info "Goose installation verified"

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
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 5. Start Goose
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_warn "Executing Goose with prompt..."
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || true
    goose -m "${SPAWN_PROMPT}"
else
    log_warn "Starting Goose..."
    sleep 1
    clear 2>/dev/null || true
    export PATH="${HOME}/.local/bin:${PATH}"
    source ~/.zshrc 2>/dev/null || true
    exec goose
fi
