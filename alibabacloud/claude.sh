#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=alibabacloud/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/alibabacloud/lib/common.sh)"
fi

log_info "Claude Code on Alibaba Cloud"
echo ""

ensure_aliyun_credentials
ensure_ssh_key

SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${ALIYUN_INSTANCE_IP}"
wait_for_cloud_init "${ALIYUN_INSTANCE_IP}" 60

log_step "Verifying Claude Code installation..."
if ! run_server "${ALIYUN_INSTANCE_IP}" "export PATH=\$HOME/.local/bin:\$PATH && command -v claude" >/dev/null 2>&1; then
    log_step "Claude Code not found, installing manually..."
    run_server "${ALIYUN_INSTANCE_IP}" "curl -fsSL https://claude.ai/install.sh | bash"
fi
log_info "Claude Code is installed"

echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

log_step "Setting up environment variables..."
inject_env_vars_ssh "${ALIYUN_INSTANCE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

setup_claude_code_config "${OPENROUTER_API_KEY}" \
    "upload_file ${ALIYUN_INSTANCE_IP}" \
    "run_server ${ALIYUN_INSTANCE_IP}"

echo ""
log_info "Alibaba Cloud instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (ID: ${ALIYUN_INSTANCE_ID}, IP: ${ALIYUN_INSTANCE_IP})"
echo ""

log_step "Starting Claude Code..."
sleep 1
clear
interactive_session "${ALIYUN_INSTANCE_IP}" "export PATH=\$HOME/.local/bin:\$PATH && source ~/.zshrc && claude"
