#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hostkey/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostkey/lib/common.sh)"
fi

log_info "Codex CLI on HOSTKEY"
echo ""

# 1. Resolve HOSTKEY API token
ensure_hostkey_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${HOSTKEY_INSTANCE_IP}"
wait_for_cloud_init "${HOSTKEY_INSTANCE_IP}" 60

# 5. Install Codex CLI
log_step "Installing Codex CLI..."
run_server "${HOSTKEY_INSTANCE_IP}" "npm install -g @openai/codex"

# Verify installation succeeded
if ! run_server "${HOSTKEY_INSTANCE_IP}" "command -v codex >/dev/null 2>&1 && codex --version >/dev/null 2>&1"; then
    log_install_failed "Codex CLI" "npm install -g @openai/codex" "${HOSTKEY_INSTANCE_IP}"
    exit 1
fi
log_info "Codex CLI installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${HOSTKEY_INSTANCE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "HOSTKEY server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${HOSTKEY_INSTANCE_ID}, IP: ${HOSTKEY_INSTANCE_IP})"
echo ""

# 7. Start Codex interactively
log_step "Starting Codex..."
sleep 1
clear
interactive_session "${HOSTKEY_INSTANCE_IP}" "source ~/.zshrc && codex"
