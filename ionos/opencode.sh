#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ionos/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ionos/lib/common.sh)"
fi

log_info "OpenCode on IONOS Cloud"
echo ""

# 1. Resolve IONOS credentials
ensure_ionos_credentials

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${IONOS_SERVER_IP}"
wait_for_cloud_init "${IONOS_SERVER_IP}" 60

# 5. Install OpenCode
log_warn "Installing OpenCode..."
run_server "${IONOS_SERVER_IP}" "$(opencode_install_cmd)"
log_info "OpenCode installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${IONOS_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "IONOS server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${IONOS_SERVER_ID}, IP: ${IONOS_SERVER_IP})"
echo ""

# 7. Start OpenCode interactively
log_warn "Starting OpenCode..."
sleep 1
clear
interactive_session "${IONOS_SERVER_IP}" "source ~/.zshrc && opencode"
