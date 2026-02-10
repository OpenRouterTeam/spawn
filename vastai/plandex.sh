#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=vastai/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/vastai/lib/common.sh)"
fi

log_info "Plandex on Vast.ai"
echo ""

# 1. Ensure vastai CLI and API key are configured
ensure_vastai_cli
ensure_vastai_token

# 2. Get instance name and create instance
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 3. Wait for SSH connectivity and install base tools
verify_server_connectivity
install_base_tools

# 4. Install Plandex
log_warn "Installing Plandex..."
run_server "${VASTAI_INSTANCE_ID}" "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation succeeded
if ! run_server "${VASTAI_INSTANCE_ID}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
    exit 1
fi
log_info "Plandex installation verified successfully"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 6. Inject environment variables
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${VASTAI_INSTANCE_ID}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "Vast.ai instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${VASTAI_INSTANCE_ID})"
echo ""

# 7. Start Plandex interactively
log_warn "Starting Plandex..."
sleep 1
clear
interactive_session "${VASTAI_INSTANCE_ID}" "source ~/.zshrc && plandex"
