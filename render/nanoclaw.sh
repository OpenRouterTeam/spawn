#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/lib/common.sh)"
fi

log_info "NanoClaw on Render"
echo ""

# 1. Ensure Render CLI and API key
ensure_render_cli
ensure_render_api_key

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for service readiness
wait_for_cloud_init

# 4. Install Node.js and dependencies
log_step "Installing Node.js..."
run_server "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"

# Verify Node.js installation
if ! run_server "command -v node" >/dev/null 2>&1; then
    log_error "Node.js installation failed"
    exit 1
fi
log_info "Node.js installed"

# 5. Install tsx globally
log_step "Installing tsx..."
run_server "npm install -g tsx"

# 6. Clone and build nanoclaw
log_step "Cloning nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git /root/nanoclaw && cd /root/nanoclaw && npm install && npm run build"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 8. Inject environment variables
log_step "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 9. Create nanoclaw .env file safely via temp file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
chmod 600 "$DOTENV_TEMP"
track_temp_file "$DOTENV_TEMP"
printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "$DOTENV_TEMP"

upload_file "$DOTENV_TEMP" "/root/nanoclaw/.env"

echo ""
log_info "Render service setup completed successfully!"
log_info "Service: $RENDER_SERVICE_NAME (ID: $RENDER_SERVICE_ID)"
echo ""

# 10. Start nanoclaw
log_step "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
sleep 1
clear
interactive_session "cd /root/nanoclaw && source /root/.bashrc && npm run dev"
