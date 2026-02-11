#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/latitude/lib/common.sh)"
fi

log_info "Continue on Latitude.sh"
echo ""

ensure_latitude_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
wait_for_server_ready "$LATITUDE_SERVER_ID"
verify_server_connectivity "$LATITUDE_SERVER_IP"

install_base_tools "$LATITUDE_SERVER_IP"

log_step "Installing Continue CLI..."
run_server "$LATITUDE_SERVER_IP" "npm install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_server "$LATITUDE_SERVER_IP" "printf '%s\n' 'export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' >> /root/.bashrc"
run_server "$LATITUDE_SERVER_IP" "printf '%s\n' 'export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}' >> /root/.zshrc"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file ${LATITUDE_SERVER_IP}" \
    "run_server ${LATITUDE_SERVER_IP}"

echo ""
log_info "Latitude.sh setup completed successfully!"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "$LATITUDE_SERVER_IP" "zsh -c 'source ~/.zshrc && cn'"
