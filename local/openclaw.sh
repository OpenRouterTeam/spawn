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

log_info "OpenClaw on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install bun if not available
if ! command -v bun &>/dev/null; then
    log_step "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="${HOME}/.bun/bin:${PATH}"
fi

# 3. Install openclaw
if command -v openclaw &>/dev/null; then
    log_info "OpenClaw already installed"
else
    log_step "Installing openclaw..."
    bun install -g openclaw
fi

# 4. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 5. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

# 6. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 7. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file" \
    "run_server"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 8. Start openclaw gateway and TUI
log_step "Starting openclaw..."
source ~/.zshrc 2>/dev/null || true
nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &
sleep 2
exec openclaw tui
