#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/modal/lib/common.sh)"
fi

log_info "Goose on Modal"
echo ""

# 1. Ensure Modal CLI
ensure_modal_cli

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Goose
log_warn "Installing Goose..."
run_server "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
log_info "Goose installed"

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
export GOOSE_PROVIDER=openrouter
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
EOF

upload_file "$ENV_TEMP" "/tmp/env_config"
run_server "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "Modal sandbox setup completed successfully!"
log_info "Sandbox: $SERVER_NAME (ID: $MODAL_SANDBOX_ID)"
echo ""

# 7. Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "source ~/.zshrc && goose"
