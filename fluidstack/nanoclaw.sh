#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=fluidstack/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fluidstack/lib/common.sh)"
fi

log_info "NanoClaw on FluidStack"
echo ""

# 1. Ensure FluidStack API key is configured
ensure_fluidstack_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get instance name and create instance
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH connectivity and install base tools
verify_server_connectivity
install_base_tools

# 5. Install Node.js dependencies
log_warn "Installing tsx..."
run_server "${FLUIDSTACK_SERVER_IP}" "/.bun/bin/bun install -g tsx"

# 6. Clone nanoclaw
log_warn "Cloning nanoclaw..."
run_server "${FLUIDSTACK_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

# 7. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 8. Inject environment variables
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${FLUIDSTACK_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 9. Create nanoclaw .env file
log_warn "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${FLUIDSTACK_SERVER_IP}" "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "${FLUIDSTACK_SERVER_IP}" "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "FluidStack instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (IP: ${FLUIDSTACK_SERVER_IP})"
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""

# 10. Start nanoclaw
log_warn "Starting nanoclaw..."
interactive_session "${FLUIDSTACK_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
