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

log_info "OpenClaw on Paperspace"
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

# 6. Install openclaw via bun
log_warn "Installing openclaw..."
run_server "${PAPERSPACE_MACHINE_IP}" "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

log_warn "Setting up environment variables..."
inject_env_vars_ssh "${PAPERSPACE_MACHINE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Configure openclaw
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" \
    "upload_file ${PAPERSPACE_MACHINE_IP}" \
    "run_server ${PAPERSPACE_MACHINE_IP}"

echo ""
log_info "Paperspace machine setup completed successfully!"
log_info "Machine: ${MACHINE_NAME} (ID: ${PAPERSPACE_MACHINE_ID}, IP: ${PAPERSPACE_MACHINE_IP})"
echo ""

# 9. Start openclaw gateway in background and launch TUI
log_warn "Starting openclaw..."
run_server "${PAPERSPACE_MACHINE_IP}" "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${PAPERSPACE_MACHINE_IP}" "source ~/.zshrc && openclaw tui"
