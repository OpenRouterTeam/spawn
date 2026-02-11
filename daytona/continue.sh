#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/daytona/lib/common.sh)"
fi

log_info "Continue on Daytona"
echo ""

ensure_daytona_cli
ensure_daytona_token

SANDBOX_NAME=$(get_server_name)
create_server "${SANDBOX_NAME}"
wait_for_cloud_init

log_warn "Installing Continue CLI..."
run_server "npm install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
run_server "printf 'export OPENROUTER_API_KEY=%s\n' '${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_server "printf 'export OPENROUTER_API_KEY=%s\n' '${OPENROUTER_API_KEY}' >> ~/.zshrc"

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
log_info "Sandbox setup completed successfully!"
echo ""

log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "source ~/.bashrc && cn"
