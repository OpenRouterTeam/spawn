#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=aws-lightsail/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws-lightsail/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "Continue on AWS Lightsail"
echo ""

ensure_aws_cli
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${LIGHTSAIL_SERVER_IP}"
wait_for_cloud_init "${LIGHTSAIL_SERVER_IP}" 60

log_step "Installing Continue CLI..."
run_server "${LIGHTSAIL_SERVER_IP}" "npm install -g @continuedev/cli"
log_info "Continue installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."

inject_env_vars_ssh "${LIGHTSAIL_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file ${LIGHTSAIL_SERVER_IP}" \
    "run_server ${LIGHTSAIL_SERVER_IP}"

echo ""
log_info "Lightsail instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (IP: ${LIGHTSAIL_SERVER_IP})"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${LIGHTSAIL_SERVER_IP}" "source ~/.zshrc && cn"
