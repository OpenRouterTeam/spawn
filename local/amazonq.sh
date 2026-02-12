#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Amazon Q on Local Machine"
echo ""

ensure_local_ready

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

log_step "Installing Amazon Q CLI..."
run_server "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
# Add to shell profile
SHELL_RC="${HOME}/.bashrc"
if [[ -f "${HOME}/.zshrc" ]]; then
    SHELL_RC="${HOME}/.zshrc"
fi

# Add env vars to shell profile
{
    echo ""
    echo "# OpenRouter API key for Amazon Q"
    echo "export OPENROUTER_API_KEY='${OPENROUTER_API_KEY}'"
    echo "export OPENAI_API_KEY='${OPENROUTER_API_KEY}'"
    echo "export OPENAI_BASE_URL='https://openrouter.ai/api/v1'"
} >> "${SHELL_RC}"

echo ""
log_info "Local setup completed successfully!"
echo ""

log_step "Starting Amazon Q..."
sleep 1
clear
interactive_session "source ${SHELL_RC} && q chat"
