#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "🚀 Spawn an OpenClaw agent on Sprite"
echo ""

# Setup sprite environment
ensure_sprite_installed
ensure_sprite_authenticated

SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "$SPRITE_NAME" 3

log_warn "Setting up sprite environment..."

# Configure shell environment
setup_shell_environment "$SPRITE_NAME"

# Install openclaw using bun
log_warn "Installing openclaw..."
run_sprite "$SPRITE_NAME" "/.sprite/languages/bun/bin/bun install -g openclaw"

# Get OpenRouter API key via OAuth
echo ""
OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_sprite "$SPRITE_NAME" \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_API_KEY=$OPENROUTER_API_KEY" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# Setup openclaw to bypass initial settings
log_warn "Configuring openclaw..."

# Remove old config and create fresh
run_sprite "$SPRITE_NAME" "rm -rf ~/.openclaw && mkdir -p ~/.openclaw"

# Generate a random gateway token
GATEWAY_TOKEN=$(openssl rand -hex 16)

# Create config file locally first, then upload
OPENCLAW_CONFIG_TEMP=$(mktemp)
chmod 600 "$OPENCLAW_CONFIG_TEMP"
cat > "$OPENCLAW_CONFIG_TEMP" << EOF
{
  "env": {
    "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}"
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "${GATEWAY_TOKEN}"
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/${MODEL_ID}"
      }
    }
  }
}
EOF

# Upload config file securely
sprite exec -s "$SPRITE_NAME" -file "$OPENCLAW_CONFIG_TEMP:/tmp/openclaw_config.json" -- bash -c "mv /tmp/openclaw_config.json ~/.openclaw/openclaw.json"
rm "$OPENCLAW_CONFIG_TEMP"

echo ""
log_info "✅ Sprite setup completed successfully!"
echo ""

# Start openclaw gateway in background and run openclaw tui
log_warn "Starting openclaw..."
sprite exec -s "$SPRITE_NAME" -- zsh -c "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && openclaw tui"
