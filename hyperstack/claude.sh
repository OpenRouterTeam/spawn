#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hyperstack/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/lib/common.sh)"
fi

log_info "Claude Code on Hyperstack"
echo ""

# 1. Resolve Hyperstack API key
ensure_hyperstack_api_key

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get VM name and environment
VM_NAME=$(get_vm_name)
ENVIRONMENT=$(get_environment_name)

# 4. Create VM
create_vm "${VM_NAME}" "${ENVIRONMENT}"

# 5. Wait for SSH
verify_server_connectivity "${HYPERSTACK_VM_IP}"

# 6. Install Claude Code
log_step "Installing Claude Code..."
run_server "${HYPERSTACK_VM_IP}" "curl -fsSL https://claude.ai/install.sh | bash"

# Verify installation succeeded
if ! run_server "${HYPERSTACK_VM_IP}" "export PATH=\$HOME/.local/bin:\$PATH && command -v claude &> /dev/null && claude --version &> /dev/null"; then
    log_install_failed "Claude Code" "curl -fsSL https://claude.ai/install.sh | bash" "${HYPERSTACK_VM_IP}"
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

log_step "Setting up environment variables..."
inject_env_vars_ssh "${HYPERSTACK_VM_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 8. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${HYPERSTACK_VM_IP}" \
    "run_server ${HYPERSTACK_VM_IP}"

echo ""
log_info "Hyperstack VM setup completed successfully!"
log_info "VM: ${VM_NAME} (ID: ${HYPERSTACK_VM_ID}, IP: ${HYPERSTACK_VM_IP})"
echo ""

# 9. Start Claude Code interactively
log_step "Starting Claude Code..."
sleep 1
clear
interactive_session "${HYPERSTACK_VM_IP}" "export PATH=\$HOME/.local/bin:\$PATH && source ~/.zshrc && claude"
