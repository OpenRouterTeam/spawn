#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=atlanticnet/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlanticnet/lib/common.sh)"
fi

log_info "Plandex on Atlantic.Net Cloud"
echo ""

ensure_atlanticnet_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

log_step "Waiting for server to be ready..."
verify_server_connectivity "${ATLANTICNET_SERVER_IP}"

log_step "Installing Plandex..."
run_server "${ATLANTICNET_SERVER_IP}" "curl -sL https://plandex.ai/install.sh | bash"

if ! run_server "${ATLANTICNET_SERVER_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
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
inject_env_vars_ssh "${ATLANTICNET_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Atlantic.Net server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${ATLANTICNET_SERVER_ID}, IP: ${ATLANTICNET_SERVER_IP})"
echo ""

if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Plandex with prompt..."
    escaped_prompt=$(printf '%q' "${SPAWN_PROMPT}")
    run_server "${ATLANTICNET_SERVER_IP}" "source ~/.bashrc && plandex new && plandex tell ${escaped_prompt}"
else
    log_step "Starting Plandex..."
    sleep 1
    clear
    interactive_session "${ATLANTICNET_SERVER_IP}" "source ~/.bashrc && plandex"
fi
