#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ramnode/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/lib/common.sh)"
fi

log_info "Plandex on RamNode Cloud"
echo ""

ensure_ramnode_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${RAMNODE_SERVER_IP}"
wait_for_cloud_init "${RAMNODE_SERVER_IP}" 60

log_step "Installing Plandex..."
run_server "${RAMNODE_SERVER_IP}" "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation
if ! run_server "${RAMNODE_SERVER_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
    log_error "The 'plandex' command is not available or not working properly"
    exit 1
fi
log_info "Plandex installation verified successfully"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${RAMNODE_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "RamNode server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${RAMNODE_SERVER_ID}, IP: ${RAMNODE_SERVER_IP})"
echo ""

# Check if running in non-interactive mode
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    # Non-interactive mode: execute prompt and exit
    log_step "Executing Plandex with prompt..."

    # Escape prompt for safe shell execution
    escaped_prompt=$(printf '%q' "${SPAWN_PROMPT}")

    # Execute without interactive session
    run_server "${RAMNODE_SERVER_IP}" "source ~/.zshrc && plandex new && plandex tell ${escaped_prompt}"
else
    # Interactive mode: start Plandex normally
    log_step "Starting Plandex..."
    sleep 1
    clear
    interactive_session "${RAMNODE_SERVER_IP}" "source ~/.zshrc && plandex"
fi
