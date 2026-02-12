#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/github-codespaces/lib/common.sh)"
fi

log_info "OpenClaw on GitHub Codespaces"
echo ""

# 1. Ensure gh CLI and authentication
ensure_gh_cli
ensure_gh_auth

# 2. Get repository and create codespace
REPO="${GITHUB_REPO:-OpenRouterTeam/spawn}"
MACHINE="${CODESPACE_MACHINE:-basicLinux32gb}"
IDLE_TIMEOUT="${CODESPACE_IDLE_TIMEOUT:-30m}"

log_info "Creating codespace for repo: $REPO"
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

# 4. Install bun and openclaw
log_step "Installing bun..."
run_server "curl -fsSL https://bun.sh/install | bash && export BUN_INSTALL=\$HOME/.bun && export PATH=\$BUN_INSTALL/bin:\$PATH && bun install -g openclaw"
log_info "openclaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "OpenClaw") || exit 1

# 7. Inject environment variables via safe temp file upload
inject_env_vars \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Setup openclaw config
log_step "Configuring openclaw..."
CONFIG_TEMP=$(mktemp)
chmod 600 "${CONFIG_TEMP}"
track_temp_file "${CONFIG_TEMP}"

cat > "${CONFIG_TEMP}" << EOF
{
  "modelId": "${MODEL_ID}",
  "provider": "anthropic"
}
EOF

upload_file "${CONFIG_TEMP}" "/tmp/openclaw_config.json"
run_server "mkdir -p ~/.config/openclaw && mv /tmp/openclaw_config.json ~/.config/openclaw/config.json"

echo ""
log_info "GitHub Codespace setup completed successfully!"
log_info "Codespace: $CODESPACE"
echo ""

# 9. Start openclaw gateway in background, then TUI
log_step "Starting openclaw..."
log_step "To delete codespace later, run: gh codespace delete --codespace $CODESPACE --force"
echo ""
sleep 1

# Launch openclaw gateway in background, then tui
run_server "source ~/.bashrc && export BUN_INSTALL=\$HOME/.bun && export PATH=\$BUN_INSTALL/bin:\$PATH && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
run_server "source ~/.bashrc && export BUN_INSTALL=\$HOME/.bun && export PATH=\$BUN_INSTALL/bin:\$PATH && openclaw tui"
