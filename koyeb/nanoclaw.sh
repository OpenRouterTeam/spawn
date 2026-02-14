#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/koyeb/lib/common.sh)"
fi

log_info "NanoClaw on Koyeb"
echo ""

# 1. Ensure Koyeb CLI and API token
ensure_koyeb_cli
ensure_koyeb_token

# 2. Create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Node.js and tsx
log_step "Installing Node.js and tsx..."
run_server "curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs && npm install -g tsx"
log_info "Node.js and tsx installed"

# 5. Clone and build NanoClaw
log_step "Cloning and building NanoClaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables
log_step "Setting up environment variables..."

inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Create NanoClaw .env file
log_step "Configuring NanoClaw..."

DOTENV_TEMP=$(mktemp)
chmod 600 "${DOTENV_TEMP}"
track_temp_file "${DOTENV_TEMP}"
printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"

upload_file "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "chmod 600 /tmp/nanoclaw_env && mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "Koyeb service setup completed successfully!"
log_info "Service: $KOYEB_SERVICE_NAME (Instance: $KOYEB_INSTANCE_ID)"
echo ""

# 9. Start NanoClaw interactively
log_step "Starting NanoClaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
sleep 1
clear
interactive_session "source /root/.bashrc && cd ~/nanoclaw && npm run dev"
