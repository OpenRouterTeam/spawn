#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=webdock/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/webdock/lib/common.sh)"
fi

log_info "Aider on Webdock"
echo ""

ensure_webdock_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${WEBDOCK_SERVER_IP}"
wait_for_cloud_init "${WEBDOCK_SERVER_IP}" 60

log_step "Installing Aider..."
run_server "${WEBDOCK_SERVER_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${WEBDOCK_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Webdock server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (slug: ${WEBDOCK_SERVER_SLUG}, IP: ${WEBDOCK_SERVER_IP})"
echo ""

log_step "Starting Aider..."
sleep 1
clear
interactive_session "${WEBDOCK_SERVER_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
