#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "Plandex on Sprite"
echo ""

# Setup sprite environment
ensure_sprite_installed
ensure_sprite_authenticated

SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "${SPRITE_NAME}"
verify_sprite_connectivity "${SPRITE_NAME}"

log_step "Setting up sprite environment..."

# Configure shell environment
setup_shell_environment "${SPRITE_NAME}"

# Install Plandex
log_step "Installing Plandex..."
run_sprite "${SPRITE_NAME}" "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation succeeded
if ! run_sprite "${SPRITE_NAME}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_install_failed "Plandex" "curl -sL https://plandex.ai/install.sh | bash"
    exit 1
fi
log_info "Plandex installation verified successfully"

# Get OpenRouter API key via OAuth
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_sprite "${SPRITE_NAME}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Sprite setup completed successfully!"
echo ""

# Check if running in non-interactive mode
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    # Non-interactive mode: execute prompt and exit
    log_step "Executing Plandex with prompt..."

    # Escape prompt for safe shell execution
    escaped_prompt=$(printf '%q' "${SPAWN_PROMPT}")

    # Execute without -tty flag
    sprite exec -s "${SPRITE_NAME}" -- zsh -c "source ~/.zshrc && plandex new && plandex tell ${escaped_prompt}"
else
    # Interactive mode: start Plandex normally
    log_step "Starting Plandex..."
    sleep 1
    clear
    sprite exec -s "${SPRITE_NAME}" -tty -- zsh -c "source ~/.zshrc && plandex"
fi
