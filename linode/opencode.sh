#!/bin/bash
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=linode/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then source "${SCRIPT_DIR}/lib/common.sh"
else eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/linode/lib/common.sh)"; fi
log_info "OpenCode on Linode"
echo ""
ensure_linode_token
ensure_ssh_key
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${LINODE_SERVER_IP}"
wait_for_cloud_init "${LINODE_SERVER_IP}" 60
log_warn "Installing OpenCode..."
run_server "${LINODE_SERVER_IP}" "curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash"
log_info "OpenCode installed"
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then log_info "Using OpenRouter API key from environment"
else OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180); fi
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${LINODE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
echo ""
log_info "Linode setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${LINODE_SERVER_ID}, IP: ${LINODE_SERVER_IP})"
echo ""
log_warn "Starting OpenCode..."
sleep 1
clear
interactive_session "${LINODE_SERVER_IP}" "source ~/.zshrc && opencode"
