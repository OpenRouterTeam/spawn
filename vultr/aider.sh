#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=vultr/lib/common.sh
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vultr/lib/common.sh)"
fi

log_info "Aider on Vultr"
echo ""

ensure_vultr_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$VULTR_SERVER_IP"
wait_for_cloud_init "$VULTR_SERVER_IP"

log_warn "Installing Aider..."
run_server "$VULTR_SERVER_IP" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$VULTR_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"

echo ""
log_info "Vultr instance setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $VULTR_SERVER_ID, IP: $VULTR_SERVER_IP)"
echo ""

log_warn "Starting Aider..."
sleep 1
clear
interactive_session "$VULTR_SERVER_IP" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
