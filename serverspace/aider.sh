#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=serverspace/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/serverspace/lib/common.sh)"
fi

log_info "Aider on ServerSpace"
echo ""

ensure_serverspace_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${SERVERSPACE_SERVER_IP}"

log_step "Waiting for cloud-init to complete..."
generic_ssh_wait "root" "${SERVERSPACE_SERVER_IP}" "${SSH_OPTS} -o ConnectTimeout=5" "test -f /root/.cloud-init-complete" "cloud-init" 60 5

log_step "Installing Aider..."
run_server "${SERVERSPACE_SERVER_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${SERVERSPACE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "ServerSpace server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${SERVERSPACE_SERVER_ID}, IP: ${SERVERSPACE_SERVER_IP})"
echo ""

log_step "Starting Aider..."
sleep 1
clear
interactive_session "${SERVERSPACE_SERVER_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
