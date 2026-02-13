#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=kamatera/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/kamatera/lib/common.sh)"
fi

log_info "Plandex on Kamatera"
echo ""

ensure_kamatera_token
generate_ssh_key_if_missing "${HOME}/.ssh/id_ed25519"

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${KAMATERA_SERVER_IP}"

log_step "Waiting for init script to complete..."
generic_ssh_wait "root" "${KAMATERA_SERVER_IP}" "${SSH_OPTS} -o ConnectTimeout=5" "test -f /root/.cloud-init-complete" "init script" 60 5

log_step "Installing Plandex..."
run_server "${KAMATERA_SERVER_IP}" "curl -sL https://plandex.ai/install.sh | bash"

if ! run_server "${KAMATERA_SERVER_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_install_failed "Plandex" "curl -sL https://plandex.ai/install.sh | bash" "${KAMATERA_SERVER_IP}"
    exit 1
fi
log_info "Plandex installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${KAMATERA_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Kamatera server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (IP: ${KAMATERA_SERVER_IP})"
echo ""

log_step "Starting Plandex..."
sleep 1
clear
interactive_session "${KAMATERA_SERVER_IP}" "source ~/.zshrc && plandex"
