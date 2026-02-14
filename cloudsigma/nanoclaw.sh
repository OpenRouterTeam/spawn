#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=cloudsigma/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cloudsigma/lib/common.sh)"
fi

log_info "NanoClaw on CloudSigma"
echo ""

ensure_cloudsigma_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${CLOUDSIGMA_SERVER_IP}"
wait_for_cloud_init "${CLOUDSIGMA_SERVER_IP}" 60

log_step "Installing Node.js and dependencies..."
run_server "${CLOUDSIGMA_SERVER_IP}" "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs && sudo npm install -g tsx"

log_step "Cloning and building nanoclaw..."
run_server "${CLOUDSIGMA_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${CLOUDSIGMA_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

log_step "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"

upload_file "${CLOUDSIGMA_SERVER_IP}" "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "${CLOUDSIGMA_SERVER_IP}" "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "CloudSigma instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (UUID: ${CLOUDSIGMA_SERVER_UUID}, IP: ${CLOUDSIGMA_SERVER_IP})"
echo ""

log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "${CLOUDSIGMA_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
