#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/github-codespaces/lib/common.sh)"
fi

log_info "Aider on GitHub Codespaces"
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

# 4. Install Aider
log_warn "Installing Aider..."
run_in_codespace "$CODESPACE" "pip install aider-chat 2>/dev/null || pip3 install aider-chat"
log_info "Aider installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1

# 7. Inject environment variables into ~/.bashrc
log_warn "Setting up environment variables..."

ENV_VARS="
export OPENROUTER_API_KEY='${OPENROUTER_API_KEY}'
"

run_in_codespace "$CODESPACE" "cat >> ~/.bashrc << 'ENVEOF'
$ENV_VARS
ENVEOF"

echo ""
log_info "GitHub Codespace setup completed successfully!"
log_info "Codespace: $CODESPACE"
echo ""

# 8. Start Aider interactively
log_warn "Starting Aider..."
log_warn "To delete codespace later, run: gh codespace delete --codespace $CODESPACE --force"
echo ""
sleep 1

# Launch Aider with model
run_in_codespace "$CODESPACE" "source ~/.bashrc && aider --model openrouter/${MODEL_ID}"
