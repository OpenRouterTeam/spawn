#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/lib/common.sh)"
fi

log_info "gptme on Render"
echo ""

# 1. Ensure Render CLI and API key
ensure_render_cli
ensure_render_api_key

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for service readiness
wait_for_cloud_init

# 4. Install gptme
log_step "Installing gptme..."
run_server "pip install gptme 2>/dev/null || pip3 install gptme"

# Verify installation
if ! run_server "command -v gptme && gptme --version" >/dev/null 2>&1; then
    log_error "gptme installation failed"
    exit 1
fi
log_info "gptme installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

# 7. Inject environment variables
log_step "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "PATH=\$HOME/.local/bin:\$PATH"

echo ""
log_info "Render service setup completed successfully!"
log_info "Service: $RENDER_SERVICE_NAME (ID: $RENDER_SERVICE_ID)"
echo ""

# 8. Start gptme interactively
log_step "Starting gptme..."
sleep 1
clear
interactive_session "source /root/.bashrc && gptme -m openrouter/${MODEL_ID}"
