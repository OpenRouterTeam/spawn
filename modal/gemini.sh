#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=modal/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/modal/lib/common.sh)"
fi

log_info "Gemini CLI on Modal"
echo ""

# 1. Ensure Modal CLI
ensure_modal_cli

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}" || {
    log_error "Failed to create Modal sandbox"
    exit 1
}
if [[ -z "${MODAL_SANDBOX_ID}" ]]; then
    log_error "MODAL_SANDBOX_ID not set after create_server"
    exit 1
fi

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Gemini CLI
log_warn "Installing Gemini CLI..."
run_server "npm install -g @google/gemini-cli"
log_info "Gemini CLI installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
trap 'rm -f "${ENV_TEMP}"' EXIT
cat > "${ENV_TEMP}" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export GEMINI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
EOF

upload_file "${ENV_TEMP}" "/tmp/env_config"
run_server "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

echo ""
log_info "Modal sandbox setup completed successfully!"
log_info "Sandbox: ${SERVER_NAME} (ID: ${MODAL_SANDBOX_ID})"
echo ""

# 7. Start Gemini interactively
log_warn "Starting Gemini..."
sleep 1
clear
interactive_session "source ~/.zshrc && gemini"
