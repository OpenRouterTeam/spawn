#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "Claude Code on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Claude Code if not already installed
if command -v claude &>/dev/null; then
    log_info "Claude Code already installed"
else
    log_step "Installing Claude Code..."
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="${HOME}/.local/bin:${PATH}"
fi

# Verify installation
if ! command -v claude &>/dev/null; then
    log_install_failed "Claude Code" "curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
fi
log_info "Claude Code installation verified"

# 3. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 4. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 5. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file" \
    "run_server"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 6. Start Claude Code
if [[ -n "${SPAWN_PROMPT:-}" ]]; then
    log_step "Executing Claude Code with prompt..."
    export PATH="${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
    source ~/.bashrc 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    claude -p "${SPAWN_PROMPT}"
else
    log_step "Starting Claude Code..."
    sleep 1
    clear 2>/dev/null || true
    export PATH="${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"
    source ~/.bashrc 2>/dev/null || true
    source ~/.zshrc 2>/dev/null || true
    exec claude
fi
