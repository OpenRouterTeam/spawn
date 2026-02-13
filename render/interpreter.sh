#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/lib/common.sh)"
fi

log_info "Open Interpreter on Render"
echo ""

# 1. Ensure Render CLI and API key
ensure_render_cli
ensure_render_api_key

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for service readiness
wait_for_cloud_init

# 4. Install Python and Open Interpreter
log_step "Installing Open Interpreter..."
run_server "apt-get update && apt-get install -y python3 python3-pip"
run_server "pip3 install open-interpreter"

# Verify installation
if ! run_server "command -v interpreter" >/dev/null 2>&1; then
    log_install_failed "Open Interpreter" "pip install open-interpreter"
    exit 1
fi
log_info "Open Interpreter installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables
log_step "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Render service setup completed successfully!"
log_info "Service: $RENDER_SERVICE_NAME (ID: $RENDER_SERVICE_ID)"
echo ""

# 7. Start Open Interpreter interactively
log_step "Starting Open Interpreter..."
sleep 1
clear
interactive_session "source /root/.bashrc && interpreter"
