#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=northflank/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/northflank/lib/common.sh)"
fi

log_info "Claude Code on Northflank"
echo ""

# 1. Ensure Northflank CLI and API token
ensure_northflank_cli
ensure_northflank_token

# 2. Get service and project names, then create service
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Claude Code
log_warn "Installing Claude Code..."
run_server "curl -fsSL https://claude.ai/install.sh | bash"

# Verify installation
if ! run_server "command -v claude" >/dev/null 2>&1; then
    log_error "Claude Code installation failed"
    exit 1
fi
log_info "Claude Code is installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into shell configs
log_warn "Setting up environment variables..."

inject_env_vars_northflank \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 7. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file" \
    "run_server"

echo ""
log_info "Northflank service setup completed successfully!"
log_info "Service: ${SERVER_NAME} (Project: ${NORTHFLANK_PROJECT_NAME})"
echo ""

# 8. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "source ~/.bashrc && claude"
