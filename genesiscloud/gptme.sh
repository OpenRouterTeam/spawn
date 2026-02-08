#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/genesiscloud/lib/common.sh)"
fi

log_info "gptme on Genesis Cloud"
echo ""

ensure_genesis_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${GENESIS_SERVER_IP}"
wait_for_cloud_init "${GENESIS_SERVER_IP}" 60

log_warn "Installing gptme..."
run_server "${GENESIS_SERVER_IP}" "pip install gptme 2>/dev/null || pip3 install gptme"

if ! run_server "${GENESIS_SERVER_IP}" "command -v gptme &> /dev/null && gptme --version &> /dev/null"; then
    log_error "gptme installation verification failed"
    log_error "The 'gptme' command is not available or not working properly on server ${GENESIS_SERVER_IP}"
    exit 1
fi
log_info "gptme installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${GENESIS_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Genesis Cloud instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${GENESIS_SERVER_ID}, IP: ${GENESIS_SERVER_IP})"
echo ""

log_warn "Starting gptme..."
sleep 1
clear
interactive_session "${GENESIS_SERVER_IP}" "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
