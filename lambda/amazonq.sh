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

log_info "Amazon Q on Lambda Cloud"
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

# 5. Install Amazon Q CLI
log_warn "Installing Amazon Q CLI..."
run_server "$LAMBDA_SERVER_IP" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"
log_info "Amazon Q CLI installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
EOF

upload_file "$LAMBDA_SERVER_IP" "$ENV_TEMP" "/tmp/env_config"
run_server "$LAMBDA_SERVER_IP" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "Lambda Cloud instance setup completed successfully!"
log_info "Instance: $SERVER_NAME (IP: $LAMBDA_SERVER_IP)"
echo ""

# 8. Start Amazon Q interactively
log_warn "Starting Amazon Q..."
sleep 1
clear
interactive_session "$LAMBDA_SERVER_IP" "source ~/.zshrc && q chat"
