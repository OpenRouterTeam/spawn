#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=cloudsigma/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cloudsigma/lib/common.sh)"
fi

log_info "OpenClaw on CloudSigma"
echo ""

ensure_cloudsigma_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${CLOUDSIGMA_SERVER_IP}"
wait_for_cloud_init "${CLOUDSIGMA_SERVER_IP}" 60

log_step "Installing openclaw..."
run_server "${CLOUDSIGMA_SERVER_IP}" "curl -fsSL https://bun.sh/install | bash && export PATH=\$HOME/.bun/bin:\$PATH && bun install -g openclaw"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${CLOUDSIGMA_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${CLOUDSIGMA_SERVER_IP}" \
    "run_server ${CLOUDSIGMA_SERVER_IP}"

echo ""
log_info "CloudSigma instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (UUID: ${CLOUDSIGMA_SERVER_UUID}, IP: ${CLOUDSIGMA_SERVER_IP})"
echo ""

log_step "Starting openclaw gateway and TUI..."
run_server "${CLOUDSIGMA_SERVER_IP}" "export PATH=\$HOME/.bun/bin:\$PATH && source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${CLOUDSIGMA_SERVER_IP}" "export PATH=\$HOME/.bun/bin:\$PATH && source ~/.zshrc && openclaw tui"
