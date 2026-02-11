#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/koyeb/lib/common.sh)"
fi

log_info "Kilo Code on Koyeb"
echo ""

# 1. Ensure Koyeb CLI and API token
ensure_koyeb_cli
ensure_koyeb_token

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Node.js and Kilo Code CLI
log_step "Installing Node.js and Kilo Code CLI..."
run_server "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && npm install -g @kilocode/cli"
log_info "Kilo Code CLI installed"

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
    "KILO_PROVIDER_TYPE=openrouter" \
    "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Koyeb service setup completed successfully!"
log_info "Service: $KOYEB_SERVICE_NAME (Instance: $KOYEB_INSTANCE_ID)"
echo ""

# 7. Start Kilo Code interactively
log_step "Starting Kilo Code..."
sleep 1
clear
interactive_session "source /root/.bashrc && kilocode"
