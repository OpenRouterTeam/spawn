#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=cherry/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cherry/lib/common.sh)"
fi

log_info "OpenClaw on Cherry Servers"
echo ""

# 1. Resolve Cherry Servers API token
ensure_cherry_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${CHERRY_SERVER_IP}"
wait_for_cloud_init "${CHERRY_SERVER_IP}" 60

# 5. Install dependencies (Node.js + Bun)
log_step "Installing Node.js and Bun..."
run_server "${CHERRY_SERVER_IP}" "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && curl -fsSL https://bun.sh/install | bash"

# 6. Install openclaw via bun
log_step "Installing openclaw..."
run_server "${CHERRY_SERVER_IP}" "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ssh "${CHERRY_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${CHERRY_SERVER_IP}" \
    "run_server ${CHERRY_SERVER_IP}"

echo ""
log_info "Cherry Servers server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${CHERRY_SERVER_ID}, IP: ${CHERRY_SERVER_IP})"
echo ""

# 9. Start openclaw gateway in background and launch TUI
log_step "Starting openclaw..."
run_server "${CHERRY_SERVER_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${CHERRY_SERVER_IP}" "source ~/.zshrc && openclaw tui"
