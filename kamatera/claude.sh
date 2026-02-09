#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=kamatera/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/kamatera/lib/common.sh)"
fi

log_info "Claude Code on Kamatera"
echo ""

ensure_kamatera_token
generate_ssh_key_if_missing "${HOME}/.ssh/id_ed25519"

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${KAMATERA_SERVER_IP}"

log_warn "Waiting for init script to complete..."
generic_ssh_wait "root" "${KAMATERA_SERVER_IP}" "${SSH_OPTS} -o ConnectTimeout=5" "test -f /root/.cloud-init-complete" "init script" 60 5

log_warn "Verifying Claude Code installation..."
if ! run_server "${KAMATERA_SERVER_IP}" "command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "${KAMATERA_SERVER_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi
log_info "Claude Code is installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${KAMATERA_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${KAMATERA_SERVER_IP}" \
    "run_server ${KAMATERA_SERVER_IP}"

echo ""
log_info "Kamatera server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (IP: ${KAMATERA_SERVER_IP})"
echo ""

log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${KAMATERA_SERVER_IP}" "source ~/.zshrc && claude"
