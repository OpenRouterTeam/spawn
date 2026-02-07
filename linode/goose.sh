#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then source "$SCRIPT_DIR/lib/common.sh"
else source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/linode/lib/common.sh); fi
log_info "Goose on Linode"
echo ""
ensure_linode_token
ensure_ssh_key
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$LINODE_SERVER_IP"
wait_for_cloud_init "$LINODE_SERVER_IP"
log_warn "Installing Goose..."
run_server "$LINODE_SERVER_IP" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
log_info "Goose installed"
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then log_info "Using OpenRouter API key from environment"
else OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180); fi
log_warn "Setting up environment variables..."
ENV_TEMP=$(mktemp)
chmod 600 "$ENV_TEMP"
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export GOOSE_PROVIDER=openrouter
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
EOF
upload_file "$LINODE_SERVER_IP" "$ENV_TEMP" "/tmp/env_config"
run_server "$LINODE_SERVER_IP" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"
echo ""
log_info "Linode setup completed successfully!"
echo ""
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "$LINODE_SERVER_IP" "source ~/.zshrc && goose"
