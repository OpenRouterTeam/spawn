#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

log_info "Gemini CLI on Hetzner Cloud"
echo ""

ensure_hcloud_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$HETZNER_SERVER_IP"
wait_for_cloud_init "$HETZNER_SERVER_IP"

log_warn "Installing Gemini CLI..."
run_server "$HETZNER_SERVER_IP" "npm install -g @google/gemini-cli"
log_info "Gemini CLI installed"

echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export GEMINI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
EOF
upload_file "$HETZNER_SERVER_IP" "$ENV_TEMP" "/tmp/env_config"
run_server "$HETZNER_SERVER_IP" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "Hetzner server setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $HETZNER_SERVER_ID, IP: $HETZNER_SERVER_IP)"
echo ""

log_warn "Starting Gemini..."
sleep 1
clear
interactive_session "$HETZNER_SERVER_IP" "source ~/.zshrc && gemini"
