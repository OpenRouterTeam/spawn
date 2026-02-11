#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=scaleway/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/scaleway/lib/common.sh)"
fi

log_info "Continue on Scaleway"
echo ""

ensure_scaleway_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${SCALEWAY_SERVER_IP}"
install_base_packages "${SCALEWAY_SERVER_IP}"

log_warn "Installing Continue CLI..."
run_server "${SCALEWAY_SERVER_IP}" "npm install -g @continuedev/cli"
log_info "Continue CLI installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${SCALEWAY_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

log_warn "Creating Continue config file..."
run_server "${SCALEWAY_SERVER_IP}" "mkdir -p ~/.continue"
run_server "${SCALEWAY_SERVER_IP}" "cat > ~/.continue/config.json << 'EOF'
{
  \"models\": [
    {
      \"title\": \"OpenRouter\",
      \"provider\": \"openrouter\",
      \"model\": \"openrouter/auto\",
      \"apiBase\": \"https://openrouter.ai/api/v1\",
      \"apiKey\": \"${OPENROUTER_API_KEY}\"
    }
  ]
}
EOF"

echo ""
log_info "Scaleway instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${SCALEWAY_SERVER_ID}, IP: ${SCALEWAY_SERVER_IP})"
echo ""

log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${SCALEWAY_SERVER_IP}" "source ~/.zshrc && cn"
