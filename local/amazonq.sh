#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "Amazon Q on local machine"
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
# Inject env vars into shell config
ENV_CONTENT="
# OpenRouter credentials for Amazon Q
export OPENROUTER_API_KEY=\"${OPENROUTER_API_KEY}\"
export OPENAI_API_KEY=\"${OPENROUTER_API_KEY}\"
export OPENAI_BASE_URL=\"https://openrouter.ai/api/v1\"
"

# Determine which shell config to use
if [[ -f "${HOME}/.zshrc" ]]; then
    SHELL_CONFIG="${HOME}/.zshrc"
elif [[ -f "${HOME}/.bashrc" ]]; then
    SHELL_CONFIG="${HOME}/.bashrc"
else
    SHELL_CONFIG="${HOME}/.profile"
fi

# Append env vars if not already present
if ! grep -q "OpenRouter credentials for Amazon Q" "${SHELL_CONFIG}" 2>/dev/null; then
    printf '%s' "${ENV_CONTENT}" >> "${SHELL_CONFIG}"
fi

# Also export for current session
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"

echo ""
log_info "Local setup completed successfully!"
echo ""

log_step "Starting Amazon Q..."
sleep 1
clear

# Source the shell config and launch Amazon Q
if [[ -n "${SHELL_CONFIG}" ]]; then
    interactive_session "source ${SHELL_CONFIG} && q chat"
else
    interactive_session "q chat"
fi
