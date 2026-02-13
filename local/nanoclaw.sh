#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/local/lib/common.sh)"
fi

log_info "NanoClaw on local machine"
echo ""

# 1. Ensure local prerequisites
ensure_local_ready

# 2. Install Node.js/npm if not available
if ! command -v npm &>/dev/null; then
    if command -v bun &>/dev/null; then
        log_info "Using bun as package manager"
    else
        log_step "Installing bun..."
        curl -fsSL https://bun.sh/install | bash
        export PATH="${HOME}/.bun/bin:${PATH}"
    fi
fi

# 3. Install tsx dependency
log_step "Installing tsx..."
if command -v bun &>/dev/null; then
    bun install -g tsx
elif command -v npm &>/dev/null; then
    npm install -g tsx
fi

# 4. Clone and build nanoclaw
if [[ -d "${HOME}/nanoclaw" ]]; then
    log_info "NanoClaw already cloned"
else
    log_step "Cloning nanoclaw..."
    git clone https://github.com/gavrielc/nanoclaw.git "${HOME}/nanoclaw"
    cd "${HOME}/nanoclaw" && npm install && npm run build
fi

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables
log_step "Setting up environment variables..."
inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 7. Create nanoclaw .env file
log_step "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
chmod 600 "${DOTENV_TEMP}"
track_temp_file "${DOTENV_TEMP}"
printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"
cp "${DOTENV_TEMP}" "${HOME}/nanoclaw/.env"

echo ""
log_info "Local setup completed successfully!"
echo ""

# 8. Start nanoclaw
log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
echo ""
source ~/.zshrc 2>/dev/null || true
cd "${HOME}/nanoclaw" && exec npm run dev
