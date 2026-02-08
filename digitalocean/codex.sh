#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "Codex CLI on DigitalOcean"
echo ""

ensure_do_token
ensure_ssh_key

DROPLET_NAME=$(get_server_name)
create_server "$DROPLET_NAME"
verify_server_connectivity "$DO_SERVER_IP"
wait_for_cloud_init "$DO_SERVER_IP"

log_warn "Installing Codex CLI..."
run_server "$DO_SERVER_IP" "npm install -g @openai/codex"
log_info "Codex CLI installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$DO_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "OPENAI_API_KEY=$OPENROUTER_API_KEY" \
    "OPENAI_BASE_URL="https://openrouter.ai/api/v1""

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: $DROPLET_NAME (ID: $DO_DROPLET_ID, IP: $DO_SERVER_IP)"
echo ""

log_warn "Starting Codex..."
sleep 1
clear
interactive_session "$DO_SERVER_IP" "source ~/.zshrc && codex"
