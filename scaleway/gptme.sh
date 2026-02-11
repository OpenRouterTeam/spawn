#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=scaleway/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/scaleway/lib/common.sh)"
fi

log_info "gptme on Scaleway"
echo ""

ensure_scaleway_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${SCALEWAY_SERVER_IP}"
install_base_packages "${SCALEWAY_SERVER_IP}"

log_step "Installing gptme..."
run_server "${SCALEWAY_SERVER_IP}" "pip install gptme 2>/dev/null || pip3 install gptme"
log_info "gptme installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${SCALEWAY_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Scaleway instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${SCALEWAY_SERVER_ID}, IP: ${SCALEWAY_SERVER_IP})"
echo ""

log_step "Starting gptme..."
sleep 1
clear
interactive_session "${SCALEWAY_SERVER_IP}" "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
