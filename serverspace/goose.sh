#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=serverspace/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/serverspace/lib/common.sh)"
fi

log_info "Goose on ServerSpace"
echo ""

ensure_serverspace_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${SERVERSPACE_SERVER_IP}"

log_step "Waiting for cloud-init to complete..."
generic_ssh_wait "root" "${SERVERSPACE_SERVER_IP}" "${SSH_OPTS} -o ConnectTimeout=5" "test -f /root/.cloud-init-complete" "cloud-init" 60 5

log_step "Installing Goose..."
run_server "${SERVERSPACE_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

if ! run_server "${SERVERSPACE_SERVER_IP}" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_install_failed "Goose" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash" "${SERVERSPACE_SERVER_IP}"
    exit 1
fi
log_info "Goose installation verified successfully"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${SERVERSPACE_SERVER_IP}" upload_file run_server \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "ServerSpace server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${SERVERSPACE_SERVER_ID}, IP: ${SERVERSPACE_SERVER_IP})"
echo ""

log_step "Starting Goose..."
sleep 1
clear
interactive_session "${SERVERSPACE_SERVER_IP}" "source ~/.zshrc && goose"
