#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)"
fi

log_info "🐾 Spawn a NanoClaw agent on Sprite"
echo ""

# Setup sprite environment
ensure_sprite_installed
ensure_sprite_authenticated

SPRITE_NAME=$(get_sprite_name)
ensure_sprite_exists "${SPRITE_NAME}" 5
verify_sprite_connectivity "${SPRITE_NAME}"

log_warn "Setting up sprite environment..."

# Configure shell environment
setup_shell_environment "${SPRITE_NAME}"

# Install Node.js dependencies
log_warn "Installing Node.js..."
run_sprite "${SPRITE_NAME}" "/.sprite/languages/bun/bin/bun install -g tsx"

# Clone nanoclaw
log_warn "Cloning nanoclaw..."
run_sprite "${SPRITE_NAME}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"

# Get OpenRouter API key via OAuth
echo ""
OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)

log_warn "Setting up environment variables..."
inject_env_vars_sprite "${SPRITE_NAME}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# Create nanoclaw .env file
log_warn "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
trap 'rm -f "${ENV_TEMP}" "${DOTENV_TEMP}"' EXIT
chmod 600 "${DOTENV_TEMP}"
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

sprite exec -s "${SPRITE_NAME}" -file "${DOTENV_TEMP}:/tmp/nanoclaw_env" -- bash -c "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "✅ Sprite setup completed successfully!"
echo ""

# Start nanoclaw
log_warn "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
sprite exec -s "${SPRITE_NAME}" -tty -- zsh -c "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
