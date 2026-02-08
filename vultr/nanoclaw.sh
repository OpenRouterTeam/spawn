#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=vultr/lib/common.sh
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vultr/lib/common.sh)"
fi

log_info "NanoClaw on Vultr"
echo ""

ensure_vultr_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$VULTR_SERVER_IP"
wait_for_cloud_init "$VULTR_SERVER_IP"

log_warn "Installing tsx..."
run_server "$VULTR_SERVER_IP" "source ~/.bashrc && bun install -g tsx"
log_warn "Cloning and building nanoclaw..."
run_server "$VULTR_SERVER_IP" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$VULTR_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

log_warn "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
chmod 600 "$DOTENV_TEMP"
cat > "$DOTENV_TEMP" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF
upload_file "$VULTR_SERVER_IP" "$DOTENV_TEMP" "/root/nanoclaw/.env"
rm "$DOTENV_TEMP"

echo ""
log_info "Vultr instance setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $VULTR_SERVER_ID, IP: $VULTR_SERVER_IP)"
echo ""

log_warn "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "$VULTR_SERVER_IP" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
