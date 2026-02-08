#!/bin/bash
set -euo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "NanoClaw on DigitalOcean"
echo ""

# 1. Resolve DigitalOcean API token
ensure_do_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get droplet name and create droplet
DROPLET_NAME=$(get_server_name)
create_server "$DROPLET_NAME"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "$DO_SERVER_IP"
wait_for_cloud_init "$DO_SERVER_IP"

# 5. Install Node.js deps and clone nanoclaw
log_warn "Installing tsx..."
run_server "$DO_SERVER_IP" "source ~/.bashrc && bun install -g tsx"

log_warn "Cloning and building nanoclaw..."
run_server "$DO_SERVER_IP" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$DO_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_BASE_URL="https://openrouter.ai/api""

# 8. Create nanoclaw .env file
log_warn "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
chmod 600 "$DOTENV_TEMP"
cat > "$DOTENV_TEMP" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "$DO_SERVER_IP" "$DOTENV_TEMP" "/root/nanoclaw/.env"
rm "$DOTENV_TEMP"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: $DROPLET_NAME (ID: $DO_DROPLET_ID, IP: $DO_SERVER_IP)"
echo ""

# 9. Start nanoclaw
log_warn "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "$DO_SERVER_IP" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
