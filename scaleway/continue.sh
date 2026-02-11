#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/scaleway/lib/common.sh)"
fi

log_info "Continue on Scaleway"
echo ""

ensure_scaleway_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

log_step "Waiting for SSH connectivity..."
verify_server_connectivity "${SCALEWAY_SERVER_IP}"
wait_for_server_ready "${SCALEWAY_SERVER_IP}"

install_base_packages "${SCALEWAY_SERVER_IP}"

log_step "Installing Continue CLI..."
run_server "${SCALEWAY_SERVER_IP}" "npm install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_server "${SCALEWAY_SERVER_IP}" "printf 'export OPENROUTER_API_KEY=\"%s\"\n' '${OPENROUTER_API_KEY}' >> /root/.bashrc"
run_server "${SCALEWAY_SERVER_IP}" "printf 'export OPENROUTER_API_KEY=\"%s\"\n' '${OPENROUTER_API_KEY}' >> /root/.zshrc"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file ${SCALEWAY_SERVER_IP}" \
    "run_server ${SCALEWAY_SERVER_IP}"

echo ""
log_info "Scaleway setup completed successfully!"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${SCALEWAY_SERVER_IP}" "zsh -c 'source ~/.zshrc && cn'"
