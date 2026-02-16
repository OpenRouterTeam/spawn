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

log_info "Aider on Hetzner Cloud"
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

# Install, configure, launch
install_agent "Aider" "pip install aider-chat 2>/dev/null || pip3 install aider-chat" "$RUN"
verify_agent "Aider" "command -v aider && aider --version" "pip install aider-chat" "$RUN"
get_or_prompt_api_key
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider") || exit 1
inject_env_vars_cb "$RUN" "$UPLOAD" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
launch_session "Hetzner server" "$SESSION" "source ~/.zshrc && aider --model openrouter/${MODEL_ID}"
