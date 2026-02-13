#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Continue on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Node.js if not already installed
if ! command -v node &>/dev/null; then
    log_error "Node.js is required but not installed"
    log_error "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# 3. Install Continue if not already installed
if command -v cn &>/dev/null; then
    log_info "Continue already installed"
else
    log_step "Installing Continue..."
    npm install -g @continuedev/cli
fi

# Verify installation
if ! command -v cn &>/dev/null; then
    log_error "Continue installation failed"
    log_error "The 'cn' command is not available"
    log_error "Try installing manually: npm install -g @continuedev/cli"
    exit 1
fi
log_info "Continue installation verified"

# 4. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 5. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

# 6. Configure Continue
log_step "Configuring Continue..."
CONTINUE_CONFIG_DIR="${HOME}/.continue"
mkdir -p "${CONTINUE_CONFIG_DIR}"

cat > "${CONTINUE_CONFIG_DIR}/config.json" <<EOF
{
  "models": [
    {
      "title": "OpenRouter",
      "provider": "openrouter",
      "model": "openrouter/auto",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}"
    }
  ]
}
EOF

echo ""
log_info "Local setup completed successfully!"
echo ""

# 7. Start Continue
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Continue with prompt..."
    source ~/.zshrc 2>/dev/null || true
    cn -p "${SPAWN_PROMPT}"
else
    log_step "Starting Continue..."
    sleep 1
    clear 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec cn
fi
