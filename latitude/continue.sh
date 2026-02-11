#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/latitude/lib/common.sh)"
fi

log_info "Continue on Latitude.sh"
echo ""

# 1. Resolve Latitude.sh API token
ensure_latitude_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for server to become active and get IP
wait_for_server_ready "${LATITUDE_SERVER_ID}" 60

# 5. Wait for SSH connectivity
verify_server_connectivity "${LATITUDE_SERVER_IP}"

# 6. Install base tools
install_base_tools "${LATITUDE_SERVER_IP}"

log_warn "Installing Continue CLI..."
run_server "${LATITUDE_SERVER_IP}" "npm install -g @continuedev/cli"

# Verify installation succeeded
if ! run_server "${LATITUDE_SERVER_IP}" "command -v cn &> /dev/null"; then
    log_error "Continue CLI installation verification failed"
    log_error "The 'cn' command is not available on server ${LATITUDE_SERVER_IP}"
    exit 1
fi
log_info "Continue CLI installation verified successfully"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${LATITUDE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

# 8. Configure Continue
log_warn "Creating Continue config file..."
run_server "${LATITUDE_SERVER_IP}" "mkdir -p ~/.continue"
run_server "${LATITUDE_SERVER_IP}" "cat > ~/.continue/config.json << 'EOF'
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
log_info "Latitude.sh server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${LATITUDE_SERVER_ID}, IP: ${LATITUDE_SERVER_IP})"
echo ""

# 9. Start Continue CLI in TUI mode
log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${LATITUDE_SERVER_IP}" "source ~/.zshrc && cn"
