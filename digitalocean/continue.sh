#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=digitalocean/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "Continue on DigitalOcean"
echo ""

ensure_do_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${DO_SERVER_IP}"
wait_for_cloud_init "${DO_SERVER_IP}" 60

log_step "Installing Continue CLI..."
run_server "${DO_SERVER_IP}" "npm install -g @continuedev/cli"
log_info "Continue installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."

inject_env_vars_ssh "${DO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file ${DO_SERVER_IP}" \
    "run_server ${DO_SERVER_IP}"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: ${SERVER_NAME} (ID: ${DO_DROPLET_ID}, IP: ${DO_SERVER_IP})"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${DO_SERVER_IP}" "source ~/.zshrc && cn"
