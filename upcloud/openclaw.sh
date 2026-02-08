#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=upcloud/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/upcloud/lib/common.sh)"
fi

log_info "OpenClaw on UpCloud"
echo ""

# 1. Ensure Python 3 is available
if ! check_python_available; then
    exit 1
fi

# 2. Resolve UpCloud API credentials
ensure_upcloud_credentials

# 3. Generate + register SSH key
ensure_ssh_key

# 4. Get server name and create server
SERVER_NAME=$(get_server_name)
SERVER_UUID=$(create_server "${SERVER_NAME}")

# 5. Wait for server to start and get IP
SERVER_IP=$(wait_for_server "${SERVER_UUID}")

# 6. Wait for SSH and cloud-init
generic_ssh_wait "root@${SERVER_IP}"
log_info "Waiting for cloud-init to complete..."
sleep 30

# 7. Install openclaw via bun
log_warn "Installing openclaw..."
run_on_server "${SERVER_IP}" "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

# 8. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${SERVER_IP}" upload_to_server run_on_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 9. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_to_server ${SERVER_IP}" \
    "run_on_server ${SERVER_IP}"

echo ""
log_info "UpCloud server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (UUID: ${SERVER_UUID}, IP: ${SERVER_IP})"
echo ""

# 10. Start openclaw gateway in background and launch TUI
log_warn "Starting openclaw..."
run_on_server "${SERVER_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${SERVER_IP}"

# 11. Cleanup on exit
echo ""
log_warn "Session ended. Cleaning up..."
destroy_server "${SERVER_UUID}"
log_info "Done!"
