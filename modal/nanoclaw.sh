#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=modal/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/modal/lib/common.sh)"
fi

log_info "NanoClaw on Modal"
echo ""

# 1. Ensure Modal CLI
ensure_modal_cli

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}" || {
    log_error "Failed to create Modal sandbox"
    exit 1
}
if [[ -z "${MODAL_SANDBOX_ID}" ]]; then
    log_error "MODAL_SANDBOX_ID not set after create_server"
    exit 1
fi

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Node.js deps and clone nanoclaw
log_step "Installing tsx..."
run_server "source ~/.bashrc && bun install -g tsx"

log_step "Cloning and building nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."

inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 7. Create nanoclaw .env file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"

upload_file "${DOTENV_TEMP}" ~/nanoclaw/.env

echo ""
log_info "Modal sandbox setup completed successfully!"
log_info "Sandbox: ${SERVER_NAME} (ID: ${MODAL_SANDBOX_ID})"
echo ""

# 8. Start nanoclaw
log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
