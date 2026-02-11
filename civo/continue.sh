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

log_warn "Installing Continue CLI..."
run_server "${CIVO_SERVER_IP}" "curl -fsSL https://bun.sh/install | bash"
run_server "${CIVO_SERVER_IP}" "export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install -g @continuedev/cli"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
run_server "${CIVO_SERVER_IP}" "cat >> ~/.bashrc << 'ENV_EOF'
export PATH=\"\$HOME/.bun/bin:\$PATH\"
export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
ENV_EOF"

run_server "${CIVO_SERVER_IP}" "cat >> ~/.zshrc << 'ENV_EOF'
export PATH=\"\$HOME/.bun/bin:\$PATH\"
export OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
ENV_EOF"

log_warn "Creating Continue config file..."
run_server "${CIVO_SERVER_IP}" "mkdir -p ~/.continue"
run_server "${CIVO_SERVER_IP}" "cat > ~/.continue/config.json << 'EOF'
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
log_info "Server setup completed successfully!"
echo ""

log_warn "Starting Continue CLI in TUI mode..."
sleep 1
clear
interactive_session "${CIVO_SERVER_IP}" "source ~/.zshrc && cn"
