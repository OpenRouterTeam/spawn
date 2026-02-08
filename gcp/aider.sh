#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=gcp/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/gcp/lib/common.sh)"
fi

log_info "Aider on GCP Compute Engine"
echo ""

# 1. Ensure gcloud is configured
ensure_gcloud

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${GCP_SERVER_IP}"
wait_for_cloud_init "${GCP_SERVER_IP}" 60

# 5. Install Aider
log_warn "Installing Aider..."
run_server "${GCP_SERVER_IP}" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Get model preference
echo ""
log_warn "Browse models at: https://openrouter.ai/models"
log_warn "Which model would you like to use with Aider?"
MODEL_ID=$(safe_read "Enter model ID [openrouter/auto]: ") || MODEL_ID=""
MODEL_ID="${MODEL_ID:-openrouter/auto}"

# 8. Inject environment variables into ~/.zshrc
log_warn "Setting up environment variables..."

ENV_TEMP=$(mktemp)
cat > "${ENV_TEMP}" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
EOF

upload_file "${GCP_SERVER_IP}" "${ENV_TEMP}" "/tmp/env_config"
run_server "${GCP_SERVER_IP}" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
rm "${ENV_TEMP}"

echo ""
log_info "GCP instance setup completed successfully!"
log_info "Instance: ${GCP_INSTANCE_NAME_ACTUAL} (Zone: ${GCP_ZONE}, IP: ${GCP_SERVER_IP})"
echo ""

# 9. Start Aider interactively
log_warn "Starting Aider..."
sleep 1
clear
interactive_session "${GCP_SERVER_IP}" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
