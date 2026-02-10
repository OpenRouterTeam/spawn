#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=vastai/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vastai/lib/common.sh)"
fi

log_info "Aider on Vast.ai"
echo ""

ensure_vastai_cli
ensure_vastai_token

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity
install_base_tools

log_warn "Installing Aider..."
run_server "${VASTAI_INSTANCE_ID}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"

if ! run_server "${VASTAI_INSTANCE_ID}" "command -v aider &> /dev/null && aider --version &> /dev/null"; then
    log_error "Aider installation verification failed"
    exit 1
fi
log_info "Aider installation verified successfully"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${VASTAI_INSTANCE_ID}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Vast.ai instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${VASTAI_INSTANCE_ID})"
echo ""

log_warn "Starting Aider..."
sleep 1
clear
interactive_session "${VASTAI_INSTANCE_ID}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
