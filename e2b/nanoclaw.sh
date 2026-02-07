#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/e2b/lib/common.sh)
fi

log_info "NanoClaw on E2B"
echo ""

# 1. Ensure E2B CLI and API token
ensure_e2b_cli
ensure_e2b_token

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Node.js deps and clone nanoclaw
log_warn "Installing tsx..."
run_server "source ~/.bashrc && bun install -g tsx"

log_warn "Cloning and building nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
EOF

upload_file "$ENV_TEMP" "/tmp/env_config"
run_server "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

# 7. Create nanoclaw .env file
log_warn "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
cat > "$DOTENV_TEMP" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "$DOTENV_TEMP" ~/nanoclaw/.env
rm "$DOTENV_TEMP"

echo ""
log_info "E2B sandbox setup completed successfully!"
log_info "Sandbox: $SERVER_NAME (ID: $E2B_SANDBOX_ID)"
echo ""

# 8. Start nanoclaw
log_warn "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
