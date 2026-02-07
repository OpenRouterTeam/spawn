#!/bin/bash
set -e

# Source common functions
# Check if running via curl | bash or locally
if [[ -n "${BASH_SOURCE[0]}" && "${BASH_SOURCE[0]}" != "-" && "${BASH_SOURCE[0]}" != "bash" ]]; then
    # Running locally - source from local file
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    source "$SCRIPT_DIR/lib/common.sh"
else
    # Running via curl | bash - download from GitHub
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)
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
echo ""
log_warn "Browse models at: https://openrouter.ai/models"
log_warn "Which model would you like to use?"
read -p "Enter model ID [openrouter/auto]: " MODEL_ID < /dev/tty
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# Inject environment variables
log_warn "Setting up environment variables..."

# Create temp file with env config
ENV_TEMP=$(mktemp)
cat > "$ENV_TEMP" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY="${OPENROUTER_API_KEY}"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
EOF

# Upload and append to zshrc
sprite exec -s "$SPRITE_NAME" -file "$ENV_TEMP:/tmp/env_config" -- bash -c "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "$ENV_TEMP"

# Setup openclaw to bypass initial settings
log_warn "Configuring openclaw..."

# Remove old config and create fresh
run_sprite "$SPRITE_NAME" "rm -rf ~/.openclaw && mkdir -p ~/.openclaw"

# Generate a random gateway token
GATEWAY_TOKEN=$(openssl rand -hex 16)

OPENCLAW_CONFIG='{
  "env": {
    "OPENROUTER_API_KEY": "'"$OPENROUTER_API_KEY"'"
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "'"$GATEWAY_TOKEN"'"
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/'"$MODEL_ID"'"
      }
    }
  }
}'

run_sprite "$SPRITE_NAME" "echo '$OPENCLAW_CONFIG' > ~/.openclaw/openclaw.json"

echo ""
log_info "✅ Sprite setup completed successfully!"
echo ""

# Start openclaw gateway in background and run openclaw tui
log_warn "Starting openclaw..."
sprite exec -s "$SPRITE_NAME" -- zsh -c "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && openclaw tui"
