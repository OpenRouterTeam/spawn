#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=ovh/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ovh/lib/common.sh)"
fi

log_info "gptme on OVHcloud"
echo ""

# 1. Resolve OVH credentials
ensure_ovh_authenticated

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get server name and create instance
SERVER_NAME=$(get_server_name)
create_ovh_instance "${SERVER_NAME}"

# 4. Wait for instance to be active and get IP
wait_for_ovh_instance "${OVH_INSTANCE_ID}"

# 5. Wait for SSH connectivity
verify_server_connectivity "${OVH_SERVER_IP}"

# 6. Install base dependencies
install_base_deps "${OVH_SERVER_IP}"

# 7. Install gptme
log_step "Installing gptme..."
run_ovh "${OVH_SERVER_IP}" "pip install gptme 2>/dev/null || pip3 install gptme"

# Verify installation succeeded
if ! run_ovh "${OVH_SERVER_IP}" "command -v gptme &> /dev/null && gptme --version &> /dev/null"; then
    log_install_failed "gptme" "pip install gptme" "${OVH_SERVER_IP}"
    exit 1
fi
log_info "gptme installation verified successfully"

# 8. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1

log_step "Setting up environment variables..."
inject_env_vars_ovh "${OVH_SERVER_IP}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "OVHcloud instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${OVH_INSTANCE_ID}, IP: ${OVH_SERVER_IP})"
echo ""

# 9. Start gptme interactively
log_step "Starting gptme..."
sleep 1
clear
interactive_session "${OVH_SERVER_IP}" "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
