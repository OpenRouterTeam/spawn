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

# 1. Ensure Railway CLI and token
ensure_railway_cli
ensure_railway_token

# 2. Get project name and create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install kilocode
log_warn "Installing Kilo Code..."
run_server "curl -fsSL https://bun.sh/install | bash && export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install -g @kilocode/cli"
log_info "Kilo Code installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into shell config
log_warn "Setting up environment variables..."

inject_env_vars \
    "KILO_PROVIDER_TYPE=openrouter" \
    "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "PATH=\$HOME/.bun/bin:\$PATH"

echo ""
log_info "Railway service setup completed successfully!"
log_info "Project: $SERVER_NAME"
echo ""

# 7. Start kilocode interactively
log_warn "Starting Kilo Code..."
sleep 1
clear
interactive_session "source ~/.bashrc && kilocode"
