#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=paperspace/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/paperspace/lib/common.sh)"
fi

log_info "Claude Code on Paperspace"
echo ""

# 1. Ensure pspace CLI is installed
ensure_pspace_installed

# 2. Resolve Paperspace API key
ensure_paperspace_api_key

# 3. Generate SSH key locally
ensure_ssh_key

# 4. Get machine name and create machine
MACHINE_NAME=$(get_machine_name)
create_machine "${MACHINE_NAME}"

# 5. Wait for SSH and system initialization
verify_server_connectivity "${PAPERSPACE_MACHINE_IP}"
wait_for_cloud_init "${PAPERSPACE_MACHINE_IP}" 120

# 6. Verify Claude Code is installed (fallback to manual install)
log_warn "Verifying Claude Code installation..."
if ! run_server "${PAPERSPACE_MACHINE_IP}" "command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_server "${PAPERSPACE_MACHINE_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi

# Verify installation succeeded
if ! run_server "${PAPERSPACE_MACHINE_IP}" "command -v claude &> /dev/null && claude --version &> /dev/null"; then
    log_error "Claude Code installation verification failed"
    log_error "The 'claude' command is not available or not working properly on machine ${PAPERSPACE_MACHINE_IP}"
    exit 1
fi
log_info "Claude Code installation verified successfully"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${PAPERSPACE_MACHINE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 8. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${PAPERSPACE_MACHINE_IP}" \
    "run_server ${PAPERSPACE_MACHINE_IP}"

echo ""
log_info "Paperspace machine setup completed successfully!"
log_info "Machine: ${MACHINE_NAME} (ID: ${PAPERSPACE_MACHINE_ID}, IP: ${PAPERSPACE_MACHINE_IP})"
echo ""

# 9. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${PAPERSPACE_MACHINE_IP}" "source ~/.zshrc && claude"
