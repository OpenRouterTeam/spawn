#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "NanoClaw on Railway"
echo ""

# 1. Ensure flyctl CLI and API token
ensure_railway_cli
ensure_railway_auth

# 2. Get app name and create machine
SERVICE_NAME=$(get_service_name)
create_server "$SERVICE_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install tsx and clone nanoclaw
log_warn "Installing tsx..."
run_server "source ~/.bashrc && bun install -g tsx"

log_warn "Cloning and building nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into shell config
log_warn "Setting up environment variables..."

inject_env_vars_railway \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "PATH=\$HOME/.bun/bin:\$PATH"

# 7. Create nanoclaw .env file
log_warn "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
chmod 600 "$DOTENV_TEMP"
cat > "$DOTENV_TEMP" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "$DOTENV_TEMP" "/root/nanoclaw/.env"
rm "$DOTENV_TEMP"

echo ""
log_info "Railway machine setup completed successfully!"
log_info "Service: $SERVICE_NAME"
echo ""

# 8. Start nanoclaw
log_warn "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
