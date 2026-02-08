#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/upcloud/lib/common.sh)"
fi

log_info "OpenCode on UpCloud"
echo ""

ensure_upcloud_credentials
generate_ssh_key_if_missing "${HOME}/.ssh/id_ed25519"

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${UPCLOUD_SERVER_IP}"
install_base_tools "${UPCLOUD_SERVER_IP}"

log_warn "Installing OpenCode..."
run_server "${UPCLOUD_SERVER_IP}" "$(opencode_install_cmd)"
log_info "OpenCode installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${UPCLOUD_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "UpCloud server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (UUID: ${UPCLOUD_SERVER_UUID}, IP: ${UPCLOUD_SERVER_IP})"
echo ""

log_warn "Starting OpenCode..."
sleep 1
clear
interactive_session "${UPCLOUD_SERVER_IP}" "source ~/.zshrc && opencode"
