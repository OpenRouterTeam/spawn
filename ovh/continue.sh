#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ovh/lib/common.sh)"
fi

log_info "Continue on OVHcloud"
echo ""

ensure_ovh_authenticated
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_ovh_instance "${SERVER_NAME}"
wait_for_ovh_instance "${OVH_INSTANCE_ID}"
verify_server_connectivity "${OVH_SERVER_IP}"

log_step "Installing base dependencies..."
install_base_deps "${OVH_SERVER_IP}"

log_step "Installing Continue CLI..."
run_ovh "${OVH_SERVER_IP}" "npm install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ovh "${OVH_SERVER_IP}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file_ovh ${OVH_SERVER_IP}" \
    "run_ovh ${OVH_SERVER_IP}"

echo ""
log_info "OVHcloud instance setup completed successfully!"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${OVH_SERVER_IP}" "zsh -c 'source ~/.zshrc && cn'"
