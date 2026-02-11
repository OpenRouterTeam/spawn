#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hostinger/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/lib/common.sh)"
fi

log_info "OpenClaw on Hostinger VPS"
echo ""

# 1. Resolve Hostinger API key
ensure_hostinger_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${HOSTINGER_VPS_IP}"
wait_for_cloud_init "${HOSTINGER_VPS_IP}" 60

# 5. Install openclaw via bun
log_warn "Installing openclaw..."
run_server "${HOSTINGER_VPS_IP}" "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${HOSTINGER_VPS_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 9. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${HOSTINGER_VPS_IP}" \
    "run_server ${HOSTINGER_VPS_IP}"

echo ""
log_info "Hostinger VPS setup completed successfully!"
log_info "VPS: ${SERVER_NAME} (ID: ${HOSTINGER_VPS_ID}, IP: ${HOSTINGER_VPS_IP})"
echo ""

# 10. Start openclaw gateway in background and launch TUI
log_warn "Starting openclaw..."
run_server "${HOSTINGER_VPS_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${HOSTINGER_VPS_IP}" "source ~/.zshrc && openclaw tui"
