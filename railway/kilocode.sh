#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Kilo Code on Railway"
echo ""

# 1. Ensure Railway CLI and API token
ensure_railway_cli
ensure_railway_token

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Node.js and npm if not present
log_warn "Ensuring Node.js and npm are installed..."
run_server "command -v node || (curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs)"

# 5. Install Kilo Code CLI
log_warn "Installing Kilo Code CLI..."
run_server "npm install -g @kilocode/cli"

# Verify installation
if ! run_server "command -v kilocode" >/dev/null 2>&1; then
    log_error "Kilo Code installation failed"
    exit 1
fi
log_info "Kilo Code installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables
log_warn "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "KILO_PROVIDER_TYPE=openrouter" \
    "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Railway service setup completed successfully!"
log_info "Service: $RAILWAY_SERVICE_NAME"
echo ""

# 8. Start Kilo Code interactively
log_warn "Starting Kilo Code..."
sleep 1
clear
interactive_session "source /root/.bashrc && kilocode"
