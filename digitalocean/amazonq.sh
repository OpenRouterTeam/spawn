#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=digitalocean/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "Amazon Q on DigitalOcean"
echo ""

ensure_do_token
ensure_ssh_key

DROPLET_NAME=$(get_server_name)
create_server "${DROPLET_NAME}"
verify_server_connectivity "${DO_SERVER_IP}"
wait_for_cloud_init "${DO_SERVER_IP}" 60

log_step "Installing Amazon Q CLI..."
run_server "${DO_SERVER_IP}" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"

# Verify installation succeeded
if ! run_server "${DO_SERVER_IP}" "command -v q &> /dev/null && q --version &> /dev/null"; then
    log_install_failed "Amazon Q CLI" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash" "${DO_SERVER_IP}"
    exit 1
fi
log_info "Amazon Q CLI installation verified successfully"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."

inject_env_vars_ssh "${DO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: ${DROPLET_NAME} (ID: ${DO_DROPLET_ID}, IP: ${DO_SERVER_IP})"
echo ""

log_step "Starting Amazon Q..."
sleep 1
clear
interactive_session "${DO_SERVER_IP}" "source ~/.zshrc && q chat"
