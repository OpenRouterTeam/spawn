#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ramnode/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/lib/common.sh)"
fi

log_info "OpenClaw on RamNode Cloud"
echo ""

# 1. Resolve RamNode credentials
ensure_ramnode_credentials

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${RAMNODE_SERVER_IP}"
wait_for_cloud_init "${RAMNODE_SERVER_IP}" 60

# 5. Install openclaw via bun
log_step "Installing openclaw..."
run_server "${RAMNODE_SERVER_IP}" "source ~/.bashrc && bun install -g openclaw"
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

log_step "Setting up environment variables..."
inject_env_vars_ssh "${RAMNODE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 9. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${RAMNODE_SERVER_IP}" \
    "run_server ${RAMNODE_SERVER_IP}"

echo ""
log_info "RamNode server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${RAMNODE_SERVER_ID}, IP: ${RAMNODE_SERVER_IP})"
echo ""

# 10. Start openclaw gateway in background and launch TUI
log_step "Starting openclaw..."
run_server "${RAMNODE_SERVER_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${RAMNODE_SERVER_IP}" "source ~/.zshrc && openclaw tui"
