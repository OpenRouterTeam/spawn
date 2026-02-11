#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=digitalocean/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/digitalocean/lib/common.sh)"
fi

log_info "Plandex on DigitalOcean"
echo ""

# 1. Resolve DigitalOcean API token
ensure_do_token

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get droplet name and create droplet
DROPLET_NAME=$(get_server_name)
create_server "${DROPLET_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${DO_SERVER_IP}"
wait_for_cloud_init "${DO_SERVER_IP}" 60

# 5. Install Plandex
log_step "Installing Plandex..."
run_server "${DO_SERVER_IP}" "curl -sL https://plandex.ai/install.sh | bash"

# Verify installation succeeded
if ! run_server "${DO_SERVER_IP}" "command -v plandex &> /dev/null && plandex version &> /dev/null"; then
    log_error "Plandex installation verification failed"
    log_error "The 'plandex' command is not available or not working properly on server ${DO_SERVER_IP}"
    exit 1
fi
log_info "Plandex installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${DO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: ${DROPLET_NAME} (ID: ${DO_DROPLET_ID}, IP: ${DO_SERVER_IP})"
echo ""

# 7. Start Plandex interactively
log_step "Starting Plandex..."
sleep 1
clear
interactive_session "${DO_SERVER_IP}" "source ~/.zshrc && plandex"
