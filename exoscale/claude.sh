#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=exoscale/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/exoscale/lib/common.sh)"
fi

log_info "Claude Code on Exoscale"
echo ""

# 1. Ensure Exoscale CLI is installed and configured
ensure_exoscale_cli

# 2. Generate SSH key
ensure_ssh_key

# 3. Get instance name and create instance
INSTANCE_NAME=$(get_instance_name)
create_instance "${INSTANCE_NAME}"

# 4. Wait for SSH and cloud-init
verify_instance_connectivity "${EXOSCALE_INSTANCE_IP}"
# Change to ubuntu user for cloud-init check
run_instance "${EXOSCALE_INSTANCE_IP}" "sudo test -f /root/.cloud-init-complete" || {
    log_warn "Waiting for cloud-init to complete..."
    sleep 5
    local max_attempts=60
    local attempt=1
    while [[ ${attempt} -le ${max_attempts} ]]; do
        if run_instance "${EXOSCALE_INSTANCE_IP}" "sudo test -f /root/.cloud-init-complete" 2>/dev/null; then
            log_info "cloud-init completed"
            break
        fi
        sleep 5
        attempt=$((attempt + 1))
    done

    if [[ ${attempt} -gt ${max_attempts} ]]; then
        log_error "cloud-init did not complete within expected time"
        exit 1
    fi
}

# 5. Verify Claude Code is installed (fallback to manual install)
log_warn "Verifying Claude Code installation..."
if ! run_instance "${EXOSCALE_INSTANCE_IP}" "command -v claude" >/dev/null 2>&1; then
    log_warn "Claude Code not found, installing manually..."
    run_instance "${EXOSCALE_INSTANCE_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi

# Verify installation succeeded
if ! run_instance "${EXOSCALE_INSTANCE_IP}" "command -v claude &> /dev/null && claude --version &> /dev/null"; then
    log_error "Claude Code installation verification failed"
    log_error "The 'claude' command is not available or not working properly on instance ${EXOSCALE_INSTANCE_IP}"
    exit 1
fi
log_info "Claude Code installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${EXOSCALE_INSTANCE_IP}" upload_file run_instance \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 7. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${EXOSCALE_INSTANCE_IP}" \
    "run_instance ${EXOSCALE_INSTANCE_IP}"

echo ""
log_info "Exoscale instance setup completed successfully!"
log_info "Instance: ${INSTANCE_NAME} (IP: ${EXOSCALE_INSTANCE_IP}, Zone: ${EXOSCALE_INSTANCE_ZONE})"
echo ""

# 8. Start Claude Code interactively
log_warn "Starting Claude Code..."
sleep 1
clear
interactive_session "${EXOSCALE_INSTANCE_IP}" "source ~/.zshrc && claude"
