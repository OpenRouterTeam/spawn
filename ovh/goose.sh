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

log_info "Goose on OVHcloud"
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

# 7. Install Goose
log_step "Installing Goose..."
run_ovh "${OVH_SERVER_IP}" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"

# Verify installation succeeded
if ! run_ovh "${OVH_SERVER_IP}" "command -v goose &> /dev/null && goose --version &> /dev/null"; then
    log_install_failed "Goose" "CONFIGURE=false curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash" "${OVH_SERVER_IP}"
    exit 1
fi
log_info "Goose installation verified successfully"

# 8. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ovh "${OVH_SERVER_IP}" \
    "GOOSE_PROVIDER=openrouter" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "OVHcloud instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${OVH_INSTANCE_ID}, IP: ${OVH_SERVER_IP})"
echo ""

# 9. Start Goose interactively
log_step "Starting Goose..."
sleep 1
clear
interactive_session "${OVH_SERVER_IP}" "source ~/.zshrc && goose"
