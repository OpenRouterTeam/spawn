#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "Claude Code on Sprite"
echo ""

# Setup sprite environment
ensure_sprite_installed
ensure_sprite_authenticated

# Gather user preferences before provisioning
prompt_github_auth

SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "${SPRITE_NAME}"
verify_sprite_connectivity "${SPRITE_NAME}"

log_step "Setting up sprite environment..."

# Configure shell environment
setup_shell_environment "${SPRITE_NAME}"

# Install Claude Code (tries curl → npm → bun with clear logging)
RUN="run_sprite ${SPRITE_NAME}"
install_claude_code "$RUN"

# Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_sprite "${SPRITE_NAME}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# Setup Claude Code settings to bypass initial setup
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file_sprite ${SPRITE_NAME}" \
    "run_sprite ${SPRITE_NAME}"

echo ""
log_info "Sprite setup completed successfully!"
echo ""

# Save sprite connection info for spawn list
save_vm_connection "sprite-console" "${USER:-root}" "" "${SPRITE_NAME}"

# Check if running in non-interactive mode
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    # Non-interactive mode: execute prompt and exit
    log_step "Executing Claude Code with prompt..."

    # Escape prompt for safe shell execution
    escaped_prompt=$(printf '%q' "${SPAWN_PROMPT}")

    # Execute without -tty flag
    sprite exec -s "${SPRITE_NAME}" -- bash -c "source ~/.bashrc 2>/dev/null; export PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; claude -p ${escaped_prompt}"
else
    # Interactive mode: start Claude Code normally
    log_step "Starting Claude Code..."
    sleep 1
    clear 2>/dev/null || true
    sprite exec -s "${SPRITE_NAME}" -tty -- bash -c 'source ~/.bashrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude'
fi
