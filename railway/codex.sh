#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Codex CLI on Railway"
echo ""

# 1. Ensure flyctl CLI and API token
ensure_railway_cli
ensure_railway_auth

# 2. Get app name and create machine
SERVICE_NAME=$(get_service_name)
create_server "$SERVICE_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Codex CLI
log_warn "Installing Codex CLI..."
run_server "npm install -g @openai/codex"
log_info "Codex CLI installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into shell config
log_warn "Setting up environment variables..."

inject_env_vars_railway \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1" \
    "PATH=\$HOME/.bun/bin:\$PATH"

echo ""
log_info "Railway machine setup completed successfully!"
log_info "Service: $SERVICE_NAME"
echo ""

# 7. Start Codex interactively
log_warn "Starting Codex..."
sleep 1
clear
interactive_session "source ~/.bashrc && codex"
