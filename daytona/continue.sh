#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/daytona/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "Continue on Daytona"
echo ""

ensure_daytona_cli
ensure_daytona_token

SANDBOX_NAME=$(get_server_name)
create_server "${SANDBOX_NAME}"
wait_for_cloud_init

log_step "Installing Continue CLI..."
run_server "npm install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

setup_continue_config "${OPENROUTER_API_KEY}" "upload_file" "run_server"

echo ""
log_info "Sandbox setup completed successfully!"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "source ~/.bashrc && cn"
