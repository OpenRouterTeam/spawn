#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hetzner/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

log_info "Amazon Q on Hetzner Cloud"
echo ""

ensure_hcloud_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${HETZNER_SERVER_IP}"
wait_for_cloud_init "${HETZNER_SERVER_IP}" 60

log_warn "Installing Amazon Q CLI..."
run_server "${HETZNER_SERVER_IP}" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"
log_info "Amazon Q CLI installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_warn "Setting up environment variables..."
ENV_TEMP=$(mktemp)
trap 'rm -f "${ENV_TEMP}"' EXIT
cat > "${ENV_TEMP}" << EOF

# [spawn:env]
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_API_KEY="${OPENROUTER_API_KEY}"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
EOF
upload_file "${HETZNER_SERVER_IP}" "${ENV_TEMP}" "/tmp/env_config"
run_server "${HETZNER_SERVER_IP}" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

echo ""
log_info "Hetzner server setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${HETZNER_SERVER_ID}, IP: ${HETZNER_SERVER_IP})"
echo ""

log_warn "Starting Amazon Q..."
sleep 1
clear
interactive_session "${HETZNER_SERVER_IP}" "source ~/.zshrc && q chat"
