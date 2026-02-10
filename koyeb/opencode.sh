#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/koyeb/lib/common.sh)"
fi

log_info "OpenCode on Koyeb"
echo ""

# 1. Ensure Koyeb CLI and API token
ensure_koyeb_cli
ensure_koyeb_token

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install OpenCode
log_warn "Installing OpenCode..."
run_server "$(opencode_install_cmd)"
log_info "OpenCode installed"

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
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Koyeb service setup completed successfully!"
log_info "Service: $KOYEB_SERVICE_NAME (Instance: $KOYEB_INSTANCE_ID)"
echo ""

# 7. Start OpenCode interactively
log_warn "Starting OpenCode..."
sleep 1
clear
interactive_session "source /root/.bashrc && opencode"
