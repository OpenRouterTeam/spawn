#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/e2b/lib/common.sh)"
fi

log_info "Aider on E2B"
echo ""

# 1. Ensure E2B CLI and API token
ensure_e2b_cli
ensure_e2b_token

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Aider
log_warn "Installing Aider..."
run_server "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Get model preference
echo ""
log_warn "Browse models at: https://openrouter.ai/models"
log_warn "Which model would you like to use with Aider?"
MODEL_ID=$(safe_read "Enter model ID [openrouter/auto]: ") || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# 7. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
EOF

upload_file "$ENV_TEMP" "/tmp/env_config"
run_server "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "E2B sandbox setup completed successfully!"
log_info "Sandbox: $SERVER_NAME (ID: $E2B_SANDBOX_ID)"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
