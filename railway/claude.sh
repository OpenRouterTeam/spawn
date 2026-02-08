#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/lib/common.sh)"
fi

log_info "Claude Code on Railway"
echo ""

# 1. Ensure Railway CLI and token
ensure_railway_cli
ensure_railway_token

# 2. Get project name and create service
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install Claude Code
log_warn "Installing Claude Code..."
run_server "curl -fsSL https://claude.ai/install.sh | bash"

# Verify installation
if ! run_server "command -v claude" >/dev/null 2>&1; then
    log_error "Claude Code installation failed"
    exit 1
fi
log_info "Claude Code installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into shell config
log_warn "Setting up environment variables..."

inject_env_vars_railway \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0" \
    "PATH=\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH"

# 7. Configure Claude Code settings
log_warn "Configuring Claude Code..."

run_server "mkdir -p ~/.claude"

# Upload settings.json
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

upload_file "$SETTINGS_TEMP" "/root/.claude/settings.json"
rm "$SETTINGS_TEMP"

# Upload ~/.claude.json global state
GLOBAL_STATE_TEMP=$(mktemp)
chmod 600 "$GLOBAL_STATE_TEMP"
cat > "$GLOBAL_STATE_TEMP" << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF

upload_file "$GLOBAL_STATE_TEMP" "/root/.claude.json"
rm "$GLOBAL_STATE_TEMP"

# Create empty CLAUDE.md
run_server "touch ~/.claude/CLAUDE.md"

echo ""
log_info "Railway service setup completed successfully!"
log_info "Project: $SERVER_NAME"
echo ""

# 8. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "source ~/.bashrc && claude"
