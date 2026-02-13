#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=codesandbox/lib/common.sh
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/codesandbox/lib/common.sh)"
fi

log_info "Plandex on CodeSandbox"
echo ""

# 1. Ensure CodeSandbox SDK/CLI and API token
ensure_codesandbox_cli
ensure_codesandbox_token

# 2. Get sandbox name and create sandbox
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 3. Wait for base tools
wait_for_cloud_init

# 4. Install Plandex
log_step "Installing Plandex..."
run_server "curl -sL https://plandex.ai/install.sh | bash"
log_info "Plandex installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables into ~/.bashrc
log_step "Setting up environment variables..."

inject_env_vars_local upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "CodeSandbox sandbox setup completed successfully!"
log_info "Sandbox: ${SERVER_NAME} (ID: ${CODESANDBOX_SANDBOX_ID})"
echo ""

# 7. Start Plandex interactively
log_step "Starting Plandex..."
sleep 1
clear
interactive_session "source ~/.bashrc && plandex"
