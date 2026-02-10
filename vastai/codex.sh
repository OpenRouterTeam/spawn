#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=vastai/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vastai/lib/common.sh)"
fi

log_info "Codex CLI on Vast.ai"
echo ""

ensure_vastai_cli
ensure_vastai_token

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity
install_base_tools

log_warn "Installing Codex CLI..."
run_server "${VASTAI_INSTANCE_ID}" "npm install -g @openai/codex"
log_info "Codex CLI installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${VASTAI_INSTANCE_ID}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Vast.ai instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${VASTAI_INSTANCE_ID})"
echo ""

log_warn "Starting Codex..."
sleep 1
clear
interactive_session "${VASTAI_INSTANCE_ID}" "source ~/.zshrc && codex"
