#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=runpod/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/runpod/lib/common.sh)"
fi

log_info "Claude Code on RunPod"
echo ""

# 1. Ensure RunPod API key is configured
ensure_runpod_token

# 2. Ensure SSH key exists (user must add to RunPod console)
ensure_ssh_key

# 3. Get pod name and create pod
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH connectivity and install base tools
verify_server_connectivity
install_base_tools

# 5. Verify Claude Code is installed (fallback to manual install)
log_warn "Verifying Claude Code installation..."
if ! run_server "${RUNPOD_POD_ID}" "export PATH=\$HOME/.local/bin:\$PATH && command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "${RUNPOD_POD_ID}" "curl -fsSL https://claude.ai/install.sh | bash"
fi
log_info "Claude Code is installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${RUNPOD_POD_ID}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 8. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${RUNPOD_POD_ID}" \
    "run_server ${RUNPOD_POD_ID}"

echo ""
log_info "RunPod pod setup completed successfully!"
log_info "Pod: ${SERVER_NAME} (ID: ${RUNPOD_POD_ID})"
echo ""

# 9. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${RUNPOD_POD_ID}" "export PATH=\$HOME/.local/bin:\$PATH && source ~/.zshrc && claude"
