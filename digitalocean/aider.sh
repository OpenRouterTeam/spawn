#!/bin/bash
set -euo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)
fi

log_info "Aider on DigitalOcean"
echo ""

# 1. Resolve DigitalOcean API token
ensure_do_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get droplet name and create droplet
DROPLET_NAME=$(get_server_name)
create_server "$DROPLET_NAME"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "$DO_SERVER_IP"
wait_for_cloud_init "$DO_SERVER_IP"

# 5. Install Aider
log_warn "Installing Aider..."
run_server "$DO_SERVER_IP" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

# Verify installation succeeded
if ! run_server "$DO_SERVER_IP" "command -v aider &> /dev/null && aider --version &> /dev/null"; then
    log_error "Aider installation verification failed"
    log_error "The 'aider' command is not available or not working properly on server $DO_SERVER_IP"
    exit 1
fi
log_info "Aider installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$DO_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: $DROPLET_NAME (ID: $DO_DROPLET_ID, IP: $DO_SERVER_IP)"
echo ""

# 9. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "$DO_SERVER_IP" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
