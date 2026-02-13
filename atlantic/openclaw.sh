#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=atlantic/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlantic/lib/common.sh)"
fi

log_info "OpenClaw on Atlantic.Net Cloud"
echo ""

# 1. Resolve Atlantic.Net API credentials
ensure_atlantic_credentials

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${ATLANTIC_SERVER_IP}"
wait_for_cloud_init "${ATLANTIC_SERVER_IP}" 60

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${ATLANTIC_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 6. Prompt for model ID
echo ""
log_step "OpenClaw Model Configuration"
if [[ -n "${MODEL_ID:-}" ]]; then
    log_info "Using model from environment: ${MODEL_ID}"
else
    MODEL_ID=$(safe_read "Enter model ID (default: openrouter/auto): ")
    MODEL_ID="${MODEL_ID:-openrouter/auto}"
fi

# 7. Start OpenClaw gateway in background
log_step "Starting OpenClaw gateway..."
run_server "${ATLANTIC_SERVER_IP}" "export OPENROUTER_API_KEY=${OPENROUTER_API_KEY} ANTHROPIC_API_KEY=${OPENROUTER_API_KEY} ANTHROPIC_BASE_URL=https://openrouter.ai/api && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2

echo ""
log_info "Atlantic.Net server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${ATLANTIC_INSTANCE_ID}, IP: ${ATLANTIC_SERVER_IP})"
echo ""

# 8. Start OpenClaw TUI interactively
log_step "Starting OpenClaw TUI..."
sleep 1
clear
interactive_session "${ATLANTIC_SERVER_IP}" "export OPENROUTER_API_KEY=${OPENROUTER_API_KEY} ANTHROPIC_API_KEY=${OPENROUTER_API_KEY} ANTHROPIC_BASE_URL=https://openrouter.ai/api && openclaw tui --model ${MODEL_ID}"
