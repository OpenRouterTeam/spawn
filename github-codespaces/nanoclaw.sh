#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/github-codespaces/lib/common.sh)"
fi

log_info "NanoClaw on GitHub Codespaces"
echo ""

# 1. Ensure gh CLI and authentication
ensure_gh_cli
ensure_gh_auth

# 2. Get repository and create codespace
REPO="${GITHUB_REPO:-OpenRouterTeam/spawn}"
MACHINE="${CODESPACE_MACHINE:-basicLinux32gb}"
IDLE_TIMEOUT="${CODESPACE_IDLE_TIMEOUT:-30m}"

log_step "Creating codespace for repo: $REPO"
CODESPACE=$(create_codespace "$REPO" "$MACHINE" "$IDLE_TIMEOUT")

if [[ -z "$CODESPACE" ]]; then
    log_error "Failed to create codespace"
    exit 1
fi

log_info "Codespace created: $CODESPACE"

# Set CODESPACE_NAME for upload_file/run_server/inject_env_vars helpers
CODESPACE_NAME="$CODESPACE"

# 3. Wait for codespace to be ready
wait_for_codespace "$CODESPACE"

# 4. Install dependencies and nanoclaw
log_step "Installing Node.js dependencies..."
run_server "npm install -g tsx"
log_info "tsx installed"

log_step "Cloning and building nanoclaw..."
run_server "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "nanoclaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables via safe temp file upload
inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 7. Create nanoclaw .env file
log_step "Configuring nanoclaw..."
DOTENV_TEMP=$(mktemp)
chmod 600 "${DOTENV_TEMP}"
track_temp_file "${DOTENV_TEMP}"

printf 'ANTHROPIC_API_KEY=%s\n' "${OPENROUTER_API_KEY}" > "${DOTENV_TEMP}"

upload_file "${DOTENV_TEMP}" "/tmp/nanoclaw_env"
run_server "mv /tmp/nanoclaw_env ~/nanoclaw/.env"

echo ""
log_info "GitHub Codespace setup completed successfully!"
log_info "Codespace: $CODESPACE"
echo ""

# 8. Start nanoclaw
log_step "Starting nanoclaw..."
log_info "You will need to scan a WhatsApp QR code to authenticate."
log_info "To delete codespace later, run: gh codespace delete --codespace $CODESPACE --force"
echo ""
sleep 1

# Launch nanoclaw
run_server "cd ~/nanoclaw && source ~/.bashrc && npm run dev"
