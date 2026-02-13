#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=cloudsigma/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cloudsigma/lib/common.sh)"
fi

log_info "Aider on CloudSigma"
echo ""

ensure_cloudsigma_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${CLOUDSIGMA_SERVER_IP}"
wait_for_cloud_init "${CLOUDSIGMA_SERVER_IP}" 60

log_step "Installing Aider..."
run_server "${CLOUDSIGMA_SERVER_IP}" "pip3 install --user aider-chat"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5181)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${CLOUDSIGMA_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_BASE=https://openrouter.ai/api/v1" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "CloudSigma instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (UUID: ${CLOUDSIGMA_SERVER_UUID}, IP: ${CLOUDSIGMA_SERVER_IP})"
echo ""

log_step "Starting Aider..."
sleep 1
clear
interactive_session "${CLOUDSIGMA_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && aider --model openrouter/anthropic/claude-sonnet-4.5"
