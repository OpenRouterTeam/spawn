#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/github-codespaces/lib/common.sh)"
fi

log_info "Claude Code on GitHub Codespaces"
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

# 3. Wait for codespace to be ready
wait_for_codespace "$CODESPACE"

# 4. Install Claude Code
log_warn "Installing Claude Code..."
run_in_codespace "$CODESPACE" "curl -fsSL https://claude.ai/install.sh | bash"

# Verify installation
if ! run_in_codespace "$CODESPACE" "command -v claude" &>/dev/null; then
    log_error "Claude Code installation failed"
    delete_codespace "$CODESPACE"
    exit 1
fi
log_info "Claude Code installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.bashrc
log_warn "Setting up environment variables..."

ENV_VARS="
export OPENROUTER_API_KEY='${OPENROUTER_API_KEY}'
export ANTHROPIC_BASE_URL='https://openrouter.ai/api'
export ANTHROPIC_AUTH_TOKEN='${OPENROUTER_API_KEY}'
export ANTHROPIC_API_KEY=''
export CLAUDE_CODE_SKIP_ONBOARDING='1'
export CLAUDE_CODE_ENABLE_TELEMETRY='0'
export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"
"

run_in_codespace "$CODESPACE" "cat >> ~/.bashrc << 'ENVEOF'
$ENV_VARS
ENVEOF"

# 7. Configure Claude Code settings
log_warn "Configuring Claude Code..."

run_in_codespace "$CODESPACE" "mkdir -p ~/.claude"

# Create settings.json
SETTINGS_JSON="{
  \"theme\": \"dark\",
  \"editor\": \"vim\",
  \"env\": {
    \"CLAUDE_CODE_ENABLE_TELEMETRY\": \"0\",
    \"ANTHROPIC_BASE_URL\": \"https://openrouter.ai/api\",
    \"ANTHROPIC_AUTH_TOKEN\": \"${OPENROUTER_API_KEY}\"
  },
  \"permissions\": {
    \"defaultMode\": \"bypassPermissions\",
    \"dangerouslySkipPermissions\": true
  }
}"

run_in_codespace "$CODESPACE" "cat > ~/.claude/settings.json << 'SETTINGSEOF'
$SETTINGS_JSON
SETTINGSEOF"

# Create global state file
GLOBAL_STATE="{
  \"hasCompletedOnboarding\": true,
  \"bypassPermissionsModeAccepted\": true
}"

run_in_codespace "$CODESPACE" "cat > ~/.claude.json << 'STATEEOF'
$GLOBAL_STATE
STATEEOF"

# Create empty CLAUDE.md
run_in_codespace "$CODESPACE" "touch ~/.claude/CLAUDE.md"

echo ""
log_info "Setup complete. Opening interactive session..."
echo ""
log_warn "To delete codespace later, run: gh codespace delete --codespace $CODESPACE --force"
echo ""

# 8. Source env vars and launch Claude
ssh_to_codespace "$CODESPACE"
