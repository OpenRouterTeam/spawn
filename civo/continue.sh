#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/civo/lib/common.sh)"
fi

log_info "Continue on Civo"
echo ""

ensure_civo_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${CIVO_SERVER_IP}"

log_step "Installing Continue CLI..."
run_server "${CIVO_SERVER_IP}" "curl -fsSL https://bun.sh/install | bash"
run_server "${CIVO_SERVER_IP}" "export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${CIVO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

setup_continue_config "${OPENROUTER_API_KEY}" \
    "upload_file ${CIVO_SERVER_IP}" \
    "run_server ${CIVO_SERVER_IP}"

echo ""
log_info "Server setup completed successfully!"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${CIVO_SERVER_IP}" "source ~/.zshrc && cn"
