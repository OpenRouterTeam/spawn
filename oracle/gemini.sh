#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=oracle/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/oracle/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

# Variables exported by create_server() in lib/common.sh
# shellcheck disable=SC2154
: "${OCI_SERVER_IP:?}" "${OCI_INSTANCE_NAME_ACTUAL:?}"


log_info "Gemini CLI on Oracle Cloud Infrastructure"
echo ""

# 1. Ensure OCI CLI is configured
ensure_oci_cli

# 2. Generate SSH key
ensure_ssh_key

# 3. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${OCI_SERVER_IP}"
wait_for_cloud_init "${OCI_SERVER_IP}" 60

# 5. Install Gemini CLI
log_step "Installing Gemini CLI..."
run_server "${OCI_SERVER_IP}" "npm install -g @google/gemini-cli"
log_info "Gemini CLI installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."

inject_env_vars_ssh "${OCI_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "GEMINI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_API_KEY=${OPENROUTER_API_KEY}" \
    "OPENAI_BASE_URL=https://openrouter.ai/api/v1"

echo ""
log_info "OCI instance setup completed successfully!"
log_info "Instance: ${OCI_INSTANCE_NAME_ACTUAL} (IP: ${OCI_SERVER_IP})"
echo ""

# 8. Start Gemini CLI interactively
log_step "Starting Gemini..."
sleep 1
clear
interactive_session "${OCI_SERVER_IP}" "source ~/.zshrc && gemini"
