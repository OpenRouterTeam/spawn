#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws-lightsail/lib/common.sh)"
fi

log_info "gptme on AWS Lightsail"
echo ""

# 1. Ensure AWS CLI is configured
ensure_aws_cli

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get instance name and create server
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "$LIGHTSAIL_SERVER_IP"
wait_for_cloud_init "$LIGHTSAIL_SERVER_IP"

# 5. Install gptme
log_warn "Installing gptme..."
run_server "$LIGHTSAIL_SERVER_IP" "pip install gptme 2>/dev/null || pip3 install gptme"
log_info "gptme installed"

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
log_warn "Which model would you like to use with gptme?"
MODEL_ID=$(safe_read "Enter model ID [openrouter/auto]: ") || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# 8. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

inject_env_vars_ssh "${LIGHTSAIL_INSTANCE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
rm "$ENV_TEMP"

echo ""
log_info "Lightsail instance setup completed successfully!"
log_info "Instance: $SERVER_NAME (IP: $LIGHTSAIL_SERVER_IP)"
echo ""

# 9. Start gptme interactively
log_warn "Starting gptme..."
sleep 1
clear
interactive_session "$LIGHTSAIL_SERVER_IP" "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
