#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/upcloud/lib/common.sh)"
fi

log_info "Continue on UpCloud"
echo ""

generate_ssh_key_if_missing
ensure_upcloud_credentials

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$UPCLOUD_SERVER_IP"

install_base_tools "$UPCLOUD_SERVER_IP"

log_warn "Installing Continue CLI..."
run_server "$UPCLOUD_SERVER_IP" "npm install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
run_server "$UPCLOUD_SERVER_IP" "printf '%s\n' 'export OPENROUTER_API_KEY=\"${OPENROUTER_API_KEY}\"' >> /root/.bashrc"
run_server "$UPCLOUD_SERVER_IP" "printf '%s\n' 'export OPENROUTER_API_KEY=\"${OPENROUTER_API_KEY}\"' >> /root/.zshrc"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file ${UPCLOUD_SERVER_IP}" \
    "run_server ${UPCLOUD_SERVER_IP}"

echo ""
log_info "UpCloud server setup completed successfully!"
echo ""

log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "$UPCLOUD_SERVER_IP" "source ~/.zshrc && cn"
