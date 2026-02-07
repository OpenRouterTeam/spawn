#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/lambda/lib/common.sh)
fi

log_info "Claude Code on Lambda Cloud"
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

# 5. Verify Claude Code is installed (fallback to manual install)
log_warn "Verifying Claude Code installation..."
if ! run_server "$LAMBDA_SERVER_IP" "command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "$LAMBDA_SERVER_IP" "curl -fsSL https://claude.ai/install.sh | bash"
fi
log_info "Claude Code is installed"

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
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_SKIP_ONBOARDING="1"
export CLAUDE_CODE_ENABLE_TELEMETRY="0"
EOF

upload_file "$LAMBDA_SERVER_IP" "$ENV_TEMP" "/tmp/env_config"
run_server "$LAMBDA_SERVER_IP" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

# 8. Configure Claude Code settings
log_warn "Configuring Claude Code..."

run_server "$LAMBDA_SERVER_IP" "mkdir -p ~/.claude"

# Upload settings.json
SETTINGS_TEMP=$(mktemp)
cat > "$SETTINGS_TEMP" << EOF
{
  "theme": "dark",
  "editor": "vim",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": "${OPENROUTER_API_KEY}"
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  }
}
EOF

upload_file "$LAMBDA_SERVER_IP" "$SETTINGS_TEMP" "/home/ubuntu/.claude/settings.json"
rm "$SETTINGS_TEMP"

# Upload ~/.claude.json global state
GLOBAL_STATE_TEMP=$(mktemp)
cat > "$GLOBAL_STATE_TEMP" << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF

upload_file "$LAMBDA_SERVER_IP" "$GLOBAL_STATE_TEMP" "/home/ubuntu/.claude.json"
rm "$GLOBAL_STATE_TEMP"

# Create empty CLAUDE.md
run_server "$LAMBDA_SERVER_IP" "touch ~/.claude/CLAUDE.md"

echo ""
log_info "Lambda Cloud instance setup completed successfully!"
log_info "Instance: $SERVER_NAME (IP: $LAMBDA_SERVER_IP)"
echo ""

# 9. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "$LAMBDA_SERVER_IP" "source ~/.zshrc && claude"
