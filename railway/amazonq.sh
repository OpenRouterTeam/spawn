#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Amazon Q CLI on Railway"
echo ""

# 1. Ensure Railway CLI and API token
ensure_railway_cli
ensure_railway_token

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Amazon Q CLI
log_step "Installing Amazon Q CLI..."
run_server "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"
log_info "Amazon Q CLI installed"

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
log_info "Railway service setup completed successfully!"
log_info "Service: $RAILWAY_SERVICE_NAME"
echo ""

# 7. Start Amazon Q interactively
log_step "Starting Amazon Q CLI..."
sleep 1
clear
interactive_session "source /root/.bashrc && q chat"
