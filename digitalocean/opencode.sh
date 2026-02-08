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

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "OpenCode on DigitalOcean"
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

# 5. Install OpenCode
log_warn "Installing OpenCode..."
run_server "${DO_SERVER_IP}" "curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash"
log_info "OpenCode installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables
log_warn "Setting up environment variables..."
inject_env_vars_ssh "${DO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: ${DROPLET_NAME} (ID: ${DO_DROPLET_ID}, IP: ${DO_SERVER_IP})"
echo ""

# 8. Start OpenCode interactively
log_warn "Starting OpenCode..."
sleep 1
clear
interactive_session "${DO_SERVER_IP}" "source ~/.zshrc && opencode"
