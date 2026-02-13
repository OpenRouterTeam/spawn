#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/upcloud/lib/common.sh)"
fi

log_info "Plandex on UpCloud"
echo ""

ensure_upcloud_credentials
generate_ssh_key_if_missing "${HOME}/.ssh/id_ed25519"

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${UPCLOUD_SERVER_IP}"
install_base_tools "${UPCLOUD_SERVER_IP}"

log_step "Installing Plandex..."
run_server "${UPCLOUD_SERVER_IP}" "curl -sL https://plandex.ai/install.sh | bash"

if ! run_server "${UPCLOUD_SERVER_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_install_failed "Plandex" "curl -sL https://plandex.ai/install.sh | bash" "${UPCLOUD_SERVER_IP}"
    exit 1
fi
log_info "Plandex installation verified successfully"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${UPCLOUD_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "UpCloud server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (UUID: ${UPCLOUD_SERVER_UUID}, IP: ${UPCLOUD_SERVER_IP})"
echo ""

log_step "Starting Plandex..."
sleep 1
clear
interactive_session "${UPCLOUD_SERVER_IP}" "source ~/.zshrc && plandex"
