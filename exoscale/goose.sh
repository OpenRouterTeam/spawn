#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=exoscale/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/exoscale/lib/common.sh)"
fi

log_info "Goose on Exoscale"
echo ""

ensure_exoscale_creds
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${EXOSCALE_SERVER_IP}"
wait_for_cloud_init "${EXOSCALE_SERVER_IP}" 60

log_warn "Installing Goose..."
run_server "${EXOSCALE_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
log_info "Goose installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${EXOSCALE_SERVER_IP}" upload_file run_server \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Exoscale instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${EXOSCALE_SERVER_ID}, IP: ${EXOSCALE_SERVER_IP})"
echo ""

log_warn "Starting Goose..."
sleep 1
clear
interactive_session "${EXOSCALE_SERVER_IP}" "source ~/.zshrc && goose"
