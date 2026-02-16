#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=gcp/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/gcp/lib/common.sh)"
fi

# Variables exported by create_server() in lib/common.sh
# shellcheck disable=SC2154
: "${GCP_SERVER_IP:?}" "${GCP_INSTANCE_NAME_ACTUAL:?}" "${GCP_ZONE:?}"


log_info "Claude Code on GCP Compute Engine"
echo ""

# 1. Ensure gcloud is configured
ensure_gcloud

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Gather user preferences before provisioning
prompt_github_auth

# 4. Get server name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${GCP_SERVER_IP}"
wait_for_cloud_init "${GCP_SERVER_IP}" 60

# 5. Install Claude Code (tries curl → npm → bun with clear logging)
RUN="run_server ${GCP_SERVER_IP}"
install_claude_code "$RUN"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."

inject_env_vars_ssh "${GCP_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 8. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${GCP_SERVER_IP}" \
    "run_server ${GCP_SERVER_IP}"

echo ""
log_info "GCP instance setup completed successfully!"
log_info "Instance: ${GCP_INSTANCE_NAME_ACTUAL} (Zone: ${GCP_ZONE}, IP: ${GCP_SERVER_IP})"
echo ""

# 9. Start Claude Code interactively
log_step "Starting Claude Code..."
sleep 1
clear
interactive_session "${GCP_SERVER_IP}" "source ~/.bashrc 2>/dev/null; source ~/.zshrc 2>/dev/null; claude"
