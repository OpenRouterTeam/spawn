#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "gptme on Sprite"
echo ""

# Setup sprite environment
ensure_sprite_installed
ensure_sprite_authenticated

SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "${SPRITE_NAME}"
verify_sprite_connectivity "$SPRITE_NAME"

log_step "Setting up sprite environment..."

# Configure shell environment
setup_shell_environment "$SPRITE_NAME"

# Install gptme
log_step "Installing gptme..."
run_sprite "$SPRITE_NAME" "pip install gptme 2>/dev/null || pip3 install gptme"

# Verify installation succeeded
if ! run_sprite "$SPRITE_NAME" "command -v gptme &> /dev/null && gptme --version &> /dev/null"; then
    log_error "gptme installation verification failed"
    log_error "The 'gptme' command is not available or not working properly"
    exit 1
fi
log_info "gptme installation verified successfully"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_sprite "$SPRITE_NAME" \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"

echo ""
log_info "Sprite setup completed successfully!"
echo ""

# Start gptme interactively
log_step "Starting gptme..."
sleep 1
clear
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
