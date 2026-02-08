#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vultr/lib/common.sh)"
fi

log_info "Claude Code on Vultr"
echo ""

ensure_vultr_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$VULTR_SERVER_IP"
wait_for_cloud_init "$VULTR_SERVER_IP"

log_warn "Verifying Claude Code installation..."
if ! run_server "$VULTR_SERVER_IP" "command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "$VULTR_SERVER_IP" "curl -fsSL https://claude.ai/install.sh | bash"
fi
log_info "Claude Code is installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "$VULTR_SERVER_IP" upload_file run_server \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

log_warn "Configuring Claude Code..."
run_server "$VULTR_SERVER_IP" "mkdir -p ~/.claude"

SETTINGS_TEMP=$(mktemp)
chmod 600 "$SETTINGS_TEMP"
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
upload_file "$VULTR_SERVER_IP" "$SETTINGS_TEMP" "/root/.claude/settings.json"
rm "$SETTINGS_TEMP"

GLOBAL_STATE_TEMP=$(mktemp)
chmod 600 "$GLOBAL_STATE_TEMP"
cat > "$GLOBAL_STATE_TEMP" << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF
upload_file "$VULTR_SERVER_IP" "$GLOBAL_STATE_TEMP" "/root/.claude.json"
rm "$GLOBAL_STATE_TEMP"

run_server "$VULTR_SERVER_IP" "touch ~/.claude/CLAUDE.md"

echo ""
log_info "Vultr instance setup completed successfully!"
log_info "Server: $SERVER_NAME (ID: $VULTR_SERVER_ID, IP: $VULTR_SERVER_IP)"
echo ""

log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "$VULTR_SERVER_IP" "source ~/.zshrc && claude"
