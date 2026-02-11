#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=scaleway/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/scaleway/lib/common.sh)"
fi

log_info "NanoClaw on Scaleway"
echo ""

ensure_scaleway_token
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${SCALEWAY_SERVER_IP}"
install_base_packages "${SCALEWAY_SERVER_IP}"

log_step "Installing tsx..."
run_server "${SCALEWAY_SERVER_IP}" "source ~/.bashrc && bun install -g tsx"
log_step "Cloning and building nanoclaw..."
run_server "${SCALEWAY_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${SCALEWAY_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

log_step "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF
upload_file "${SCALEWAY_SERVER_IP}" "${DOTENV_TEMP}" "/root/nanoclaw/.env"

echo ""
log_info "Scaleway instance setup completed successfully!"
log_info "Server: ${SERVER_NAME} (ID: ${SCALEWAY_SERVER_ID}, IP: ${SCALEWAY_SERVER_IP})"
echo ""

log_step "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "${SCALEWAY_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
