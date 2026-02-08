#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=scaleway/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/scaleway/lib/common.sh)"
fi

log_info "Claude Code on Scaleway"
echo ""

ensure_scaleway_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${SCALEWAY_SERVER_IP}"
install_base_packages "${SCALEWAY_SERVER_IP}"

log_warn "Installing Claude Code..."
run_server "${SCALEWAY_SERVER_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
log_info "Claude Code installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${SCALEWAY_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${SCALEWAY_SERVER_IP}" \
    "run_server ${SCALEWAY_SERVER_IP}"

echo ""
log_info "Scaleway instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${SCALEWAY_SERVER_ID}, IP: ${SCALEWAY_SERVER_IP})"
echo ""

log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${SCALEWAY_SERVER_IP}" "source ~/.zshrc && claude"
