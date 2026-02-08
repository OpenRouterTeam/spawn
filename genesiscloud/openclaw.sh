#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=genesiscloud/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/genesiscloud/lib/common.sh)"
fi

log_info "OpenClaw on Genesis Cloud"
echo ""

ensure_genesis_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${GENESIS_SERVER_IP}"
wait_for_cloud_init "${GENESIS_SERVER_IP}" 60

log_warn "Installing openclaw..."
run_server "${GENESIS_SERVER_IP}" "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${GENESIS_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${GENESIS_SERVER_IP}" \
    "run_server ${GENESIS_SERVER_IP}"

echo ""
log_info "Genesis Cloud server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${GENESIS_SERVER_ID}, IP: ${GENESIS_SERVER_IP})"
echo ""

log_warn "Starting openclaw..."
run_server "${GENESIS_SERVER_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${GENESIS_SERVER_IP}" "source ~/.zshrc && openclaw tui"
