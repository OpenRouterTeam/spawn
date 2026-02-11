#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=modal/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/modal/lib/common.sh)"
fi

log_info "Continue on Modal"
echo ""

ensure_modal_cli

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
wait_for_cloud_init

log_warn "Installing Continue CLI..."
run_server "npm install -g @continuedev/cli"
log_info "Continue installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
run_server "printf 'export OPENROUTER_API_KEY=\"%s\"\n' '${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_server "printf 'export OPENROUTER_API_KEY=\"%s\"\n' '${OPENROUTER_API_KEY}' >> ~/.zshrc"

setup_continue_config "${OPENROUTER_API_KEY}" "upload_file" "run_server"

echo ""
log_info "Modal sandbox setup completed successfully!"
log_info "Sandbox ID: ${MODAL_SANDBOX_ID}"
echo ""

log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "source ~/.zshrc && cn"
