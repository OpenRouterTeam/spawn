#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/lib/common.sh)"
fi

log_info "OpenClaw on Render"
echo ""

# 1. Ensure Render CLI and API key
ensure_render_cli
ensure_render_api_key

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for service readiness
wait_for_cloud_init

# 4. Install Bun
log_step "Installing Bun..."
run_server "curl -fsSL https://bun.sh/install | bash"

# Verify Bun installation
if ! run_server "command -v /root/.bun/bin/bun" >/dev/null 2>&1; then
    log_error "Bun installation failed"
    exit 1
fi
log_info "Bun installed"

# 5. Install openclaw using Bun
log_step "Installing openclaw..."
run_server "/root/.bun/bin/bun install -g openclaw"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

# 8. Inject environment variables
log_step "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "PATH=\$HOME/.bun/bin:\$PATH"

# 9. Configure openclaw settings via shared helper (uses json_escape for safe key handling)
setup_openclaw_config "$OPENROUTER_API_KEY" "$MODEL_ID" "upload_file" "run_server"

echo ""
log_info "Render service setup completed successfully!"
log_info "Service: $RENDER_SERVICE_NAME (ID: $RENDER_SERVICE_ID)"
echo ""

# 10. Start openclaw
log_step "Starting openclaw..."
log_step "Starting gateway in background, then launching TUI..."
sleep 1
clear
interactive_session "source /root/.bashrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 & sleep 2 && openclaw tui"
