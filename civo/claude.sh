#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=civo/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/civo/lib/common.sh)"
fi

log_info "Claude Code on Civo"
echo ""

ensure_civo_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${CIVO_SERVER_IP}"

log_warn "Waiting for cloud-init to complete..."
# Civo uses init scripts, wait for completion marker
generic_ssh_wait "root" "${CIVO_SERVER_IP}" "${SSH_OPTS} -o ConnectTimeout=5" "test -f /root/.cloud-init-complete" "cloud-init" 60 5

log_warn "Verifying Claude Code installation..."
if ! run_server "${CIVO_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "${CIVO_SERVER_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi
log_info "Claude Code is installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${CIVO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${CIVO_SERVER_IP}" \
    "run_server ${CIVO_SERVER_IP}"

echo ""
log_info "Civo instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${CIVO_SERVER_ID}, IP: ${CIVO_SERVER_IP})"
echo ""

log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${CIVO_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && source ~/.zshrc && claude"
