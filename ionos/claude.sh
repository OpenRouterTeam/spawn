#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ionos/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ionos/lib/common.sh)"
fi

log_info "Claude Code on IONOS Cloud"
echo ""

# 1. Resolve IONOS credentials
ensure_ionos_credentials

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${IONOS_SERVER_IP}"
wait_for_cloud_init "${IONOS_SERVER_IP}" 60

# 5. Verify Claude Code is installed (fallback to manual install)
log_warn "Verifying Claude Code installation..."
if ! run_server "${IONOS_SERVER_IP}" "command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "${IONOS_SERVER_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi

# Verify installation succeeded
if ! run_server "${IONOS_SERVER_IP}" "command -v claude &> /dev/null && claude --version &> /dev/null"; then
    log_error "Claude Code installation verification failed"
    log_error "The 'claude' command is not available or not working properly on server ${IONOS_SERVER_IP}"
    exit 1
fi
log_info "Claude Code installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${IONOS_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 8. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${IONOS_SERVER_IP}" \
    "run_server ${IONOS_SERVER_IP}"

echo ""
log_info "IONOS server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${IONOS_SERVER_ID}, IP: ${IONOS_SERVER_IP})"
echo ""

# 9. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${IONOS_SERVER_IP}" "source ~/.zshrc && claude"
