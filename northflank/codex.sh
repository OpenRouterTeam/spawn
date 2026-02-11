#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/northflank/lib/common.sh)"
fi

log_info "Codex CLI on Northflank"
echo ""

ensure_northflank_cli
ensure_northflank_token

NORTHFLANK_SERVICE_NAME=$(get_server_name)
NORTHFLANK_PROJECT_NAME=$(get_project_name)

create_server "${NORTHFLANK_SERVICE_NAME}"
wait_for_cloud_init

log_step "Installing Codex CLI..."
run_server "npm install -g @openai/codex"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_northflank \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "Northflank setup completed successfully!"
echo ""

log_step "Starting Codex..."
sleep 1
clear
interactive_session "source ~/.bashrc && codex"
