#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/northflank/lib/common.sh)"
fi

log_info "Spawn a NanoClaw agent on Northflank"
echo ""

# Ensure Northflank CLI is installed
ensure_northflank_cli

# Authenticate with Northflank
ensure_northflank_token

# Get project and service names
PROJECT_NAME=$(get_project_name)
SERVER_NAME=$(get_server_name)

# Create server/service
create_server "${SERVER_NAME}"

# Wait for container to be ready and install base tools
wait_for_cloud_init

log_step "Installing Node.js dependencies..."
run_server "export PATH=\"\$HOME/.bun/bin:\$PATH\" && bun install -g tsx" >/dev/null 2>&1 || true

# Clone nanoclaw
log_step "Cloning nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

# Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_northflank \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# Create nanoclaw .env file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
chmod 600 "${DOTENV_TEMP}"
track_temp_file "${DOTENV_TEMP}"

printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"

upload_file "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "Northflank setup completed successfully!"
echo ""

# Start nanoclaw
log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "cd ~/nanoclaw && source ~/.bashrc && npm run dev"
