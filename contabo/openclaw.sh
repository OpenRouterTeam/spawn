#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=contabo/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/contabo/lib/common.sh)"
fi

log_info "OpenClaw on Contabo"
echo ""

# 1. Resolve Contabo credentials
ensure_contabo_credentials

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${CONTABO_SERVER_IP}"
wait_for_cloud_init "${CONTABO_SERVER_IP}" 60

# 5. Install OpenClaw
log_step "Installing OpenClaw..."
run_server "${CONTABO_SERVER_IP}" "bun install -g openclaw"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model ID
log_info "OpenClaw natively supports OpenRouter"
printf "Enter model ID [openrouter/auto]: "
MODEL_ID=$(safe_read) || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

log_step "Setting up environment variables..."
inject_env_vars_ssh "${CONTABO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

echo ""
log_info "Contabo instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${CONTABO_INSTANCE_ID}, IP: ${CONTABO_SERVER_IP})"
log_info "Starting OpenClaw gateway in background..."
run_server "${CONTABO_SERVER_IP}" "nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2

echo ""
# 8. Start OpenClaw TUI interactively
log_step "Starting OpenClaw TUI..."
sleep 1
clear
interactive_session "${CONTABO_SERVER_IP}" "source ~/.zshrc && openclaw tui"
