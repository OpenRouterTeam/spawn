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

log_info "Aider on Exoscale"
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
# Wait for cloud-init
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

# 5. Install Aider
log_warn "Installing Aider..."
run_instance "${EXOSCALE_INSTANCE_IP}" "pip install aider-chat"

# Verify installation
if ! run_instance "${EXOSCALE_INSTANCE_IP}" "command -v aider &> /dev/null"; then
    log_error "Aider installation verification failed"
    log_error "The 'aider' command is not available on instance ${EXOSCALE_INSTANCE_IP}"
    exit 1
fi
log_info "Aider installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model ID
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider")

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${EXOSCALE_INSTANCE_IP}" upload_file run_instance \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "MODEL_ID=${MODEL_ID}"

echo ""
log_info "Exoscale instance setup completed successfully!"
log_info "Instance: ${INSTANCE_NAME} (IP: ${EXOSCALE_INSTANCE_IP}, Zone: ${EXOSCALE_INSTANCE_ZONE})"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "${EXOSCALE_INSTANCE_IP}" "source ~/.zshrc && aider --model openrouter/\${MODEL_ID}"
