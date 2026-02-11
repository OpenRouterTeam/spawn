#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=netcup/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/netcup/lib/common.sh)"
fi

log_info "OpenClaw on Netcup Cloud"
echo ""

# 1. Resolve Netcup credentials
ensure_netcup_credentials

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${NETCUP_SERVER_IP}"
wait_for_cloud_init "${NETCUP_SERVER_IP}" 60

# 5. Install bun
log_step "Installing bun..."
run_server "${NETCUP_SERVER_IP}" "curl -fsSL https://bun.sh/install | bash"

# 6. Install openclaw
log_step "Installing openclaw..."
run_server "${NETCUP_SERVER_IP}" "export PATH=\$HOME/.bun/bin:\$PATH && bun install -g openclaw"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 8. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${NETCUP_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 9. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${NETCUP_SERVER_IP}" \
    "run_server ${NETCUP_SERVER_IP}"

echo ""
log_info "Netcup VPS setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${NETCUP_SERVER_ID}, IP: ${NETCUP_SERVER_IP})"
echo ""

# 10. Start openclaw gateway in background and run openclaw tui
log_step "Starting openclaw..."
run_server "${NETCUP_SERVER_IP}" "export PATH=\$HOME/.bun/bin:\$PATH && source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${NETCUP_SERVER_IP}" "export PATH=\$HOME/.bun/bin:\$PATH && source ~/.zshrc && openclaw tui"
