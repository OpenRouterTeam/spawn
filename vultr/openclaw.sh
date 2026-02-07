#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vultr/lib/common.sh)
fi

log_info "OpenClaw on Vultr"
echo ""

ensure_vultr_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$VULTR_SERVER_IP"
wait_for_cloud_init "$VULTR_SERVER_IP"

log_warn "Installing openclaw..."
run_server "$VULTR_SERVER_IP" "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$VULTR_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_BASE_URL="https://openrouter.ai/api""

log_warn "Configuring openclaw..."
run_server "$VULTR_SERVER_IP" "rm -rf ~/.openclaw && mkdir -p ~/.openclaw"
GATEWAY_TOKEN=$(openssl rand -hex 16)

OPENCLAW_CONFIG_TEMP=$(mktemp)
chmod 600 "$OPENCLAW_CONFIG_TEMP"
cat > "$OPENCLAW_CONFIG_TEMP" << EOF
{
  "env": { "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}" },
  "gateway": { "mode": "local", "auth": { "token": "${GATEWAY_TOKEN}" } },
  "agents": { "defaults": { "model": { "primary": "openrouter/${MODEL_ID}" } } }
}
EOF
upload_file "$VULTR_SERVER_IP" "$OPENCLAW_CONFIG_TEMP" "/root/.openclaw/openclaw.json"
rm "$OPENCLAW_CONFIG_TEMP"

echo ""
log_info "Vultr instance setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $VULTR_SERVER_ID, IP: $VULTR_SERVER_IP)"
echo ""

log_warn "Starting openclaw..."
run_server "$VULTR_SERVER_IP" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "$VULTR_SERVER_IP" "source ~/.zshrc && openclaw tui"
