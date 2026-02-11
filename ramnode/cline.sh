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

log_info "Cline on RamNode Cloud"
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

# 5. Verify Cline is installed (fallback to manual install)
log_warn "Verifying Cline installation..."
if ! run_server "${RAMNODE_SERVER_IP}" "command -v cline" >/dev/null 2>&1; then
    log_warn "Cline not found, installing manually..."
    run_server "${RAMNODE_SERVER_IP}" "npm install -g cline"
fi

# Verify installation succeeded
if ! run_server "${RAMNODE_SERVER_IP}" "command -v cline &> /dev/null"; then
    log_error "Cline installation verification failed"
    exit 1
fi
log_info "Cline installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${RAMNODE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "RamNode server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${RAMNODE_SERVER_ID}, IP: ${RAMNODE_SERVER_IP})"
echo ""

# 7. Start Cline interactively
log_warn "Starting Cline..."
sleep 1
clear
interactive_session "${RAMNODE_SERVER_IP}" "source ~/.zshrc && cline"
