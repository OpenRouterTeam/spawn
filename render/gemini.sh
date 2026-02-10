#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/lib/common.sh)"
fi

log_info "Gemini CLI on Render"
echo ""

# 1. Ensure Render CLI and API key
ensure_render_cli
ensure_render_api_key

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for service readiness
wait_for_cloud_init

# 4. Install Node.js and Gemini CLI
log_warn "Installing Gemini CLI..."
run_server "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs"
run_server "npm install -g @google/gemini-cli"

# Verify installation
if ! run_server "command -v gemini" >/dev/null 2>&1; then
    log_error "Gemini CLI installation failed"
    exit 1
fi
log_info "Gemini CLI installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables
log_warn "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "GEMINI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1" \
    "PATH=\$HOME/.npm-global/bin:\$PATH"

echo ""
log_info "Render service setup completed successfully!"
log_info "Service: $RENDER_SERVICE_NAME (ID: $RENDER_SERVICE_ID)"
echo ""

# 7. Start Gemini interactively
log_warn "Starting Gemini..."
sleep 1
clear
interactive_session "source /root/.bashrc && gemini"
