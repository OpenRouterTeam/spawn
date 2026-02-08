#!/bin/bash
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then source "$SCRIPT_DIR/lib/common.sh"
else eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/linode/lib/common.sh)"; fi
log_info "Codex CLI on Linode"
echo ""
ensure_linode_token
ensure_ssh_key
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$LINODE_SERVER_IP"
wait_for_cloud_init "$LINODE_SERVER_IP"
log_warn "Installing Codex CLI..."
run_server "$LINODE_SERVER_IP" "npm install -g @openai/codex"
log_info "Codex CLI installed"
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then log_info "Using OpenRouter API key from environment"
else OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180); fi
log_warn "Setting up environment variables..."
inject_env_vars_ssh "$LINODE_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "OPENAI_API_KEY=$OPENROUTER_API_KEY" \
    "OPENAI_BASE_URL="https://openrouter.ai/api/v1""
echo ""
log_info "Linode setup completed successfully!"
echo ""
log_warn "Starting Codex..."
sleep 1
clear
interactive_session "$LINODE_SERVER_IP" "source ~/.zshrc && codex"
