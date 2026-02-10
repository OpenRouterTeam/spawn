#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Aider on Railway"
echo ""

# 1. Ensure Railway CLI and API token
ensure_railway_cli
ensure_railway_token

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools (already in Docker image)
wait_for_cloud_init

# 4. Install Aider
log_warn "Installing Aider..."
run_server "pip install aider-chat"

# Verify installation
if ! run_server "command -v aider" >/dev/null 2>&1; then
    log_error "Aider installation failed"
    exit 1
fi
log_info "Aider installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Prompt for model ID
echo ""
MODEL_ID=$(safe_read "Enter model ID (default: openrouter/auto): ")
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# 7. Inject environment variables
log_warn "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "MODEL_ID=${MODEL_ID}"

echo ""
log_info "Railway service setup completed successfully!"
log_info "Project: $RAILWAY_PROJECT_NAME (Service: $RAILWAY_SERVICE_NAME)"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "source /root/.bashrc && aider --model openrouter/\${MODEL_ID}"
