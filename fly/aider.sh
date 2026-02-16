#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "Aider on Fly.io"
echo ""

# 1. Ensure flyctl CLI and API token
ensure_fly_cli
ensure_fly_token

# 2. Get app name and create machine
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Aider
log_step "Installing Aider..."
run_server "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

# 7. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."

inject_env_vars_fly \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "PATH=\$HOME/.bun/bin:\$PATH"

echo ""
log_info "Fly.io machine setup completed successfully!"
log_info "App: $SERVER_NAME (Machine ID: $FLY_MACHINE_ID)"
echo ""

# 8. Start Aider interactively
log_step "Starting Aider..."
sleep 1
clear
interactive_session "source ~/.bashrc && aider --model openrouter/${MODEL_ID}"
