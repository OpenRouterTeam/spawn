#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lambda/lib/common.sh
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/lambda/lib/common.sh)"
fi

log_info "Aider on Lambda Cloud"
echo ""

# 1. Ensure Lambda API key is configured
ensure_lambda_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get instance name and create server
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "$LAMBDA_SERVER_IP"
wait_for_cloud_init "$LAMBDA_SERVER_IP"

# 5. Install Aider
log_warn "Installing Aider..."
run_server "$LAMBDA_SERVER_IP" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model preference
echo ""
log_warn "Browse models at: https://openrouter.ai/models"
log_warn "Which model would you like to use with Aider?"
MODEL_ID=$(safe_read "Enter model ID [openrouter/auto]: ") || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# 8. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
EOF

upload_file "$LAMBDA_SERVER_IP" "$ENV_TEMP" "/tmp/env_config"
run_server "$LAMBDA_SERVER_IP" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "Lambda Cloud instance setup completed successfully!"
log_info "Instance: $SERVER_NAME (IP: $LAMBDA_SERVER_IP)"
echo ""

# 9. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "$LAMBDA_SERVER_IP" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
