#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hetzner/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "OpenClaw on Hetzner Cloud"
echo ""

# Provision server
ensure_hcloud_token
ensure_ssh_key
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${HETZNER_SERVER_IP}"
wait_for_cloud_init "${HETZNER_SERVER_IP}" 60

# Set up callbacks
RUN="run_server ${HETZNER_SERVER_IP}"
UPLOAD="upload_file ${HETZNER_SERVER_IP}"

# Install, configure
install_agent "openclaw" "source ~/.bashrc && bun install -g openclaw" "$RUN"
get_or_prompt_api_key
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1
inject_env_vars_cb "$RUN" "$UPLOAD" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" "$UPLOAD" "$RUN"

echo ""
log_info "Hetzner server setup completed successfully!"
echo ""

# Start openclaw gateway in background, then launch TUI
log_step "Starting openclaw..."
${RUN} "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "${HETZNER_SERVER_IP}" "source ~/.zshrc && openclaw tui"
