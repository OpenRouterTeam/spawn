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

log_info "Continue on RamNode Cloud"
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

# 5. Verify Continue is installed (fallback to manual install)
log_step "Verifying Continue installation..."
if ! run_server "${RAMNODE_SERVER_IP}" "command -v cn" >/dev/null 2>&1; then
    log_step "Continue not found, installing manually..."
    run_server "${RAMNODE_SERVER_IP}" "npm install -g @continuedev/cli"
fi

# Verify installation succeeded
if ! run_server "${RAMNODE_SERVER_IP}" "command -v cn &> /dev/null"; then
    log_install_failed "Continue" "npm install -g @continuedev/cli" "${RAMNODE_SERVER_IP}"
    exit 1
fi
log_info "Continue installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${RAMNODE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

# 7. Configure Continue config.json
log_step "Configuring Continue..."
CONFIG_CONTENT=$(python3 -c "
import json, sys
config = {
    'models': [
        {
            'title': 'OpenRouter',
            'provider': 'openrouter',
            'model': 'openrouter/auto',
            'apiBase': 'https://openrouter.ai/api/v1',
            'apiKey': sys.argv[1]
        }
    ]
}
print(json.dumps(config, indent=2))
" "${OPENROUTER_API_KEY}")

run_server "${RAMNODE_SERVER_IP}" "mkdir -p ~/.continue"
echo "$CONFIG_CONTENT" | upload_file "${RAMNODE_SERVER_IP}" - ~/.continue/config.json

echo ""
log_info "RamNode server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${RAMNODE_SERVER_ID}, IP: ${RAMNODE_SERVER_IP})"
echo ""

# 8. Start Continue interactively
log_step "Starting Continue..."
sleep 1
clear
interactive_session "${RAMNODE_SERVER_IP}" "source ~/.zshrc && cn"
