#!/bin/bash
set -e

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)
fi

log_info "Claude Code on Sprite"
echo ""

# Setup sprite environment
ensure_sprite_installed
ensure_sprite_authenticated

SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "$SPRITE_NAME" 5
verify_sprite_connectivity "$SPRITE_NAME"

log_warn "Setting up sprite environment..."

# Configure shell environment
setup_shell_environment "$SPRITE_NAME"

# Install Claude Code using claude install
log_warn "Installing Claude Code..."
run_sprite "$SPRITE_NAME" "claude install > /dev/null 2>&1"

# Get OpenRouter API key via OAuth
echo ""
OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)

# Inject environment variables
log_warn "Setting up environment variables..."

# Create temp file with env config
ENV_TEMP=$(mktemp)
chmod 600 "$ENV_TEMP"
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_SKIP_ONBOARDING="1"
export CLAUDE_CODE_ENABLE_TELEMETRY="0"
EOF

# Upload and append to zshrc
sprite exec -s "$SPRITE_NAME" -file "$ENV_TEMP:/tmp/env_config" -- bash -c "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

# Setup Claude Code settings to bypass initial setup
log_warn "Configuring Claude Code..."

run_sprite "$SPRITE_NAME" "mkdir -p ~/.claude"

# Create Claude settings.json via file upload
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

sprite exec -s "$SPRITE_NAME" -file "$SETTINGS_TEMP:/tmp/claude_settings" -- bash -c "mv /tmp/claude_settings ~/.claude/settings.json"
rm "$SETTINGS_TEMP"

# Create ~/.claude.json global state to skip onboarding and trust dialogs
GLOBAL_STATE_TEMP=$(mktemp)
chmod 600 "$GLOBAL_STATE_TEMP"
cat > "$GLOBAL_STATE_TEMP" << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF

sprite exec -s "$SPRITE_NAME" -file "$GLOBAL_STATE_TEMP:/tmp/claude_global" -- bash -c "mv /tmp/claude_global ~/.claude.json"
rm "$GLOBAL_STATE_TEMP"

# Create empty CLAUDE.md to prevent first-run prompts
run_sprite "$SPRITE_NAME" "touch ~/.claude/CLAUDE.md"

echo ""
log_info "✅ Sprite setup completed successfully!"
echo ""

# Start Claude Code immediately
log_warn "Starting Claude Code..."
sleep 1
clear
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && claude"
