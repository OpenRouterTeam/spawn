#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

log_info "gptme on Hetzner Cloud"
echo ""

# 1. Resolve Hetzner API token
ensure_hcloud_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "$HETZNER_SERVER_IP"
wait_for_cloud_init "$HETZNER_SERVER_IP"

# 5. Install gptme
log_warn "Installing gptme..."
run_server "$HETZNER_SERVER_IP" "pip install gptme 2>/dev/null || pip3 install gptme"

# Verify installation succeeded
if ! run_server "$HETZNER_SERVER_IP" "command -v gptme &> /dev/null && gptme --version &> /dev/null"; then
    log_error "gptme installation verification failed"
    log_error "The 'gptme' command is not available or not working properly on server $HETZNER_SERVER_IP"
    exit 1
fi
log_info "gptme installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$HETZNER_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"

echo ""
log_info "Hetzner server setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $HETZNER_SERVER_ID, IP: $HETZNER_SERVER_IP)"
echo ""

# 9. Start gptme interactively
log_warn "Starting gptme..."
sleep 1
clear
interactive_session "$HETZNER_SERVER_IP" "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
