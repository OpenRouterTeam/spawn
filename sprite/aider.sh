#!/bin/bash
set -euo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)
fi

log_info "Aider on Sprite"
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

# Install Aider
log_warn "Installing Aider..."
run_sprite "$SPRITE_NAME" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
echo ""
log_warn "Browse models at: https://openrouter.ai/models"
log_warn "Which model would you like to use with Aider?"
MODEL_ID=$(safe_read "Enter model ID [openrouter/auto]: ") || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# Validate model ID for security
if ! validate_model_id "$MODEL_ID"; then
    log_error "Exiting due to invalid model ID"
    exit 1
fi

log_warn "Setting up environment variables..."
inject_env_vars_sprite "$SPRITE_NAME" \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"

echo ""
log_info "Sprite setup completed successfully!"
echo ""

# Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
