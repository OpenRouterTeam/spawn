#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=hetzner/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

log_info "Claude Code on Hetzner Cloud"
echo ""

# Provision server
ensure_hcloud_token
ensure_ssh_key
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"
verify_server_connectivity "${HETZNER_SERVER_IP}"
wait_for_cloud_init "${HETZNER_SERVER_IP}" 60

# Set up callbacks
RUN="run_server ${HETZNER_SERVER_IP}"
UPLOAD="upload_file ${HETZNER_SERVER_IP}"
SESSION="interactive_session ${HETZNER_SERVER_IP}"

# Install Claude Code (tries curl → npm → bun with clear logging)
install_claude_code "$RUN"

get_or_prompt_api_key
inject_env_vars_cb "$RUN" "$UPLOAD" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=" \
    "CLAUDE_CODE_SKIP_ONBOARDING=1" \
    "CLAUDE_CODE_ENABLE_TELEMETRY=0"

# Claude-specific config
setup_claude_code_config "${OPENROUTER_API_KEY}" "$UPLOAD" "$RUN"

launch_session "Hetzner server" "$SESSION" "export PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH && source ~/.zshrc && claude"
