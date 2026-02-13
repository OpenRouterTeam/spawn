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

log_info "Claude Code on DigitalOcean"
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

# 5. Verify Claude Code is installed (fallback to manual install)
log_step "Verifying Claude Code installation..."
if ! run_server "${DO_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && command -v claude" >/dev/null 2>&1; then
    log_step "Claude Code not found, installing manually..."
    run_server "${DO_SERVER_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi

# Verify installation succeeded
if ! run_server "${DO_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && command -v claude &> /dev/null && claude --version &> /dev/null"; then
    log_install_failed "Claude Code" "curl -fsSL https://claude.ai/install.sh | bash" "${DO_SERVER_IP}"
    exit 1
fi
log_info "Claude Code installation verified successfully"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."
inject_env_vars_ssh "${DO_SERVER_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# 8. Configure Claude Code settings
setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${DO_SERVER_IP}" \
    "run_server ${DO_SERVER_IP}"

echo ""
log_info "DigitalOcean droplet setup completed successfully!"
log_info "Droplet: ${DROPLET_NAME} (ID: ${DO_DROPLET_ID}, IP: ${DO_SERVER_IP})"
echo ""

# 9. Start Claude Code interactively
log_step "Starting Claude Code..."
sleep 1
clear
interactive_session "${DO_SERVER_IP}" "export PATH=\$HOME/.local/bin:\$PATH && source ~/.zshrc && claude"
