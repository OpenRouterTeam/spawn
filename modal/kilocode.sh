#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=modal/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/modal/lib/common.sh)"
fi

log_info "Kilo Code on Modal"
echo ""

# 1. Ensure Modal CLI
ensure_modal_cli

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}" || {
    log_error "Failed to create Modal sandbox"
    exit 1
}
if [[ -z "${MODAL_SANDBOX_ID}" ]]; then
    log_error "MODAL_SANDBOX_ID not set after create_server"
    exit 1
fi

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Kilo Code
log_step "Installing Kilo Code..."
run_server "npm install -g @kilocode/cli"
log_info "Kilo Code installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."

inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "KILO_PROVIDER_TYPE=openrouter" \
    "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Modal sandbox setup completed successfully!"
log_info "Sandbox: ${SERVER_NAME} (ID: ${MODAL_SANDBOX_ID})"
echo ""

# 7. Start Kilo Code interactively
log_step "Starting Kilo Code..."
sleep 1
clear
interactive_session "source ~/.zshrc && kilocode"
