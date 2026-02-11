#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=github-codespaces/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/github-codespaces/lib/common.sh)"
fi

log_info "Continue on GitHub Codespaces"
echo ""

ensure_gh_cli
ensure_gh_auth

REPO="${GH_CODESPACE_REPO:-OpenRouterTeam/spawn}"
MACHINE="${GH_CODESPACE_MACHINE:-basicLinux32gb}"
IDLE_TIMEOUT="${GH_CODESPACE_IDLE_TIMEOUT:-30m}"

CODESPACE_NAME=$(create_codespace "${REPO}" "${MACHINE}" "${IDLE_TIMEOUT}")
export CODESPACE_NAME

wait_for_codespace "${CODESPACE_NAME}"

log_step "Installing Continue CLI..."
run_in_codespace "${CODESPACE_NAME}" "npm install -g @continuedev/cli"
log_info "Continue installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
run_in_codespace "${CODESPACE_NAME}" "printf 'export OPENROUTER_API_KEY=\"%s\"\n' '${OPENROUTER_API_KEY}' >> ~/.bashrc"
run_in_codespace "${CODESPACE_NAME}" "printf 'export OPENROUTER_API_KEY=\"%s\"\n' '${OPENROUTER_API_KEY}' >> ~/.zshrc"

setup_continue_config "${OPENROUTER_API_KEY}" "upload_file" "run_server"

echo ""
log_info "Codespace setup completed successfully!"
log_info "Codespace: ${CODESPACE_NAME}"
echo ""

log_step "Starting Continue CLI in TUI mode..."
sleep 1
clear
gh codespace ssh --codespace "${CODESPACE_NAME}" -- "source ~/.zshrc && cn"
