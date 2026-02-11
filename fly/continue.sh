#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

log_info "Continue on Fly.io"
echo ""

# 1. Ensure flyctl CLI and API token
ensure_fly_cli
ensure_fly_token

# 2. Get app name and create machine
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Continue CLI
log_warn "Installing Continue CLI..."
run_server "npm install -g @continuedev/cli"

# Verify installation
if ! run_server "command -v cn" >/dev/null 2>&1; then
    log_error "Continue CLI installation failed"
    exit 1
fi
log_info "Continue CLI installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

inject_env_vars_fly \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

# 7. Configure Continue
log_warn "Creating Continue config file..."

run_server "mkdir -p ~/.continue"
run_server "cat > ~/.continue/config.json << 'EOF'
{
  \"models\": [
    {
      \"title\": \"OpenRouter\",
      \"provider\": \"openrouter\",
      \"model\": \"openrouter/auto\",
      \"apiBase\": \"https://openrouter.ai/api/v1\",
      \"apiKey\": \"${OPENROUTER_API_KEY}\"
    }
  ]
}
EOF"

echo ""
log_info "Fly.io machine setup completed successfully!"
log_info "App: $SERVER_NAME (Machine ID: $FLY_MACHINE_ID)"
echo ""

# 8. Start Continue CLI in TUI mode
log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "source ~/.bashrc && cn"
