#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=runpod/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/runpod/lib/common.sh)"
fi

log_info "OpenClaw on RunPod GPU Cloud"
echo ""

# 1. Resolve RunPod API token
ensure_runpod_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get pod name and create pod
POD_NAME=$(get_server_name)
create_server "${POD_NAME}"

# 4. Wait for SSH and install tools
verify_server_connectivity "${RUNPOD_POD_IP}" "${RUNPOD_SSH_PORT}"
wait_for_cloud_init "${RUNPOD_POD_IP}" "${RUNPOD_SSH_PORT}"

# 5. Install OpenClaw
log_warn "Installing OpenClaw..."
run_server "${RUNPOD_POD_IP}" "bun install -g openclaw"

# Verify installation succeeded
if ! run_server "${RUNPOD_POD_IP}" "command -v openclaw &> /dev/null && openclaw --version &> /dev/null"; then
    log_error "OpenClaw installation verification failed"
    log_error "The 'openclaw' command is not available or not working properly on pod ${RUNPOD_POD_ID}"
    exit 1
fi
log_info "OpenClaw installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model ID interactively
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "OpenClaw")

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${RUNPOD_POD_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Configure OpenClaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${RUNPOD_POD_IP}" \
    "run_server ${RUNPOD_POD_IP}"

echo ""
log_info "RunPod pod setup completed successfully!"
log_info "Pod: ${POD_NAME} (ID: ${RUNPOD_POD_ID}, IP: ${RUNPOD_POD_IP}:${RUNPOD_SSH_PORT})"
echo ""

# 9. Start OpenClaw gateway and TUI
log_warn "Starting OpenClaw..."
sleep 1
clear
interactive_session "${RUNPOD_POD_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 & sleep 2 && openclaw tui"
