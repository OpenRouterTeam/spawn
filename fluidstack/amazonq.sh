#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=fluidstack/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fluidstack/lib/common.sh)"
fi

log_info "Amazon Q CLI on FluidStack"
echo ""

# 1. Ensure FluidStack API key is configured
ensure_fluidstack_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get instance name and create instance
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH connectivity and install base tools
verify_server_connectivity
install_base_tools

# 5. Install Amazon Q CLI
log_warn "Installing Amazon Q CLI..."
run_server "${FLUIDSTACK_SERVER_IP}" "curl -fsSL https://desktop-release.q.us-east-1.amazonaws.com/latest/amazon-q-cli-install.sh | bash"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${FLUIDSTACK_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "FluidStack instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (IP: ${FLUIDSTACK_SERVER_IP})"
echo ""

# 8. Start Amazon Q interactively
log_warn "Starting Amazon Q..."
sleep 1
clear
interactive_session "${FLUIDSTACK_SERVER_IP}" "source ~/.zshrc && q chat"
