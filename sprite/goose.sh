#!/bin/bash
set -euo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "Goose on Sprite"
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

# Install Goose
log_warn "Installing Goose..."
run_sprite "$SPRITE_NAME" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_sprite "$SPRITE_NAME" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_error "Goose installation verification failed"
    log_error "The 'goose' command is not available or not working properly"
    exit 1
fi
log_info "Goose installation verified successfully"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "$OPENROUTER_API_KEY" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_sprite "$SPRITE_NAME" \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"

echo ""
log_info "Sprite setup completed successfully!"
echo ""

# Start Goose interactively
log_warn "Starting Goose..."
sleep 1
clear
sprite exec -s "$SPRITE_NAME" -tty -- zsh -c "source ~/.zshrc && goose"
