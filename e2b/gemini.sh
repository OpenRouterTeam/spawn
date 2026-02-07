#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/e2b/lib/common.sh)
fi

log_info "Gemini CLI on E2B"
echo ""

# 1. Ensure E2B CLI and API token
ensure_e2b_cli
ensure_e2b_token

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Gemini CLI
log_warn "Installing Gemini CLI..."
run_server "npm install -g @google/gemini-cli"
log_info "Gemini CLI installed"

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
export GEMINI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
EOF

upload_file "$ENV_TEMP" "/tmp/env_config"
run_server "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "E2B sandbox setup completed successfully!"
log_info "Sandbox: $SERVER_NAME (ID: $E2B_SANDBOX_ID)"
echo ""

# 7. Start Gemini interactively
log_warn "Starting Gemini..."
sleep 1
clear
interactive_session "source ~/.zshrc && gemini"
