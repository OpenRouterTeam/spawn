#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=koyeb/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/koyeb/lib/common.sh)"
fi

log_info "Continue on Koyeb"
echo ""

ensure_koyeb_cli
ensure_koyeb_token

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

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

inject_env_vars_koyeb "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

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
log_info "Koyeb service setup completed successfully!"
log_info "Service: ${SERVER_NAME} (App: ${KOYEB_APP_NAME})"
echo ""

log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "source ~/.zshrc && cn"
