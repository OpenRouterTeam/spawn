#!/bin/bash
set -euo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)
fi

log_info "Goose on Hetzner Cloud"
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

# 5. Install Goose
log_warn "Installing Goose..."
run_server "$HETZNER_SERVER_IP" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
log_info "Goose installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
chmod 600 "$ENV_TEMP"
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export GOOSE_PROVIDER=openrouter
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
EOF

upload_file "$HETZNER_SERVER_IP" "$ENV_TEMP" "/tmp/env_config"
run_server "$HETZNER_SERVER_IP" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

echo ""
log_info "Hetzner server setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $HETZNER_SERVER_ID, IP: $HETZNER_SERVER_IP)"
echo ""

# 8. Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
interactive_session "$HETZNER_SERVER_IP" "source ~/.zshrc && goose"
