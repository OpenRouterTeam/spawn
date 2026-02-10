#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=vastai/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vastai/lib/common.sh)"
fi

log_info "NanoClaw on Vast.ai"
echo ""

# 1. Ensure vastai CLI and API key are configured
ensure_vastai_cli
ensure_vastai_token

# 2. Get instance name and create instance
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 3. Wait for SSH connectivity and install base tools
verify_server_connectivity
install_base_tools

# 4. Install Node.js deps and clone nanoclaw
log_warn "Installing tsx..."
run_server "${VASTAI_INSTANCE_ID}" "source ~/.bashrc && bun install -g tsx"

log_warn "Cloning and building nanoclaw..."
run_server "${VASTAI_INSTANCE_ID}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${VASTAI_INSTANCE_ID}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 7. Create nanoclaw .env file
log_warn "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${VASTAI_INSTANCE_ID}" "${DOTENV_TEMP}" "/root/nanoclaw/.env"

echo ""
log_info "Vast.ai instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${VASTAI_INSTANCE_ID})"
echo ""

# 8. Start nanoclaw
log_warn "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "${VASTAI_INSTANCE_ID}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
