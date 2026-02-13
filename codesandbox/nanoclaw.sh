#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=codesandbox/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "NanoClaw on CodeSandbox"
echo ""

# 1. Ensure CodeSandbox SDK/CLI and API token
ensure_codesandbox_cli
ensure_codesandbox_token

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Node.js dependencies
log_step "Installing Node.js dependencies..."
run_server "source ~/.bashrc && PATH=\"\$HOME/.bun/bin:\$PATH\" bun install -g tsx"
log_info "Dependencies installed"

# 5. Clone and build nanoclaw
log_step "Cloning nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables
log_step "Setting up environment variables..."

inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Create nanoclaw .env file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
trap 'rm -f "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${DOTENV_TEMP}" ~/nanoclaw/.env
run_server "chmod 600 ~/nanoclaw/.env"

echo ""
log_info "CodeSandbox sandbox setup completed successfully!"
log_info "Sandbox: ${SERVER_NAME} (ID: ${CODESANDBOX_SANDBOX_ID})"
echo ""

# 9. Start nanoclaw interactively
log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
sleep 1
interactive_session "source ~/.bashrc && cd ~/nanoclaw && npm run dev"
