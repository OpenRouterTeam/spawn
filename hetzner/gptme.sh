#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hetzner/lib/common.sh)"
fi

# Register cleanup trap handler for temp files
register_cleanup_trap

log_info "gptme on Hetzner Cloud"
echo ""

# Provision server
ensure_hcloud_token
ensure_ssh_key
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"
verify_server_connectivity "$HETZNER_SERVER_IP"
wait_for_cloud_init "$HETZNER_SERVER_IP"

# Set up callbacks
RUN="run_server ${HETZNER_SERVER_IP}"
UPLOAD="upload_file ${HETZNER_SERVER_IP}"
SESSION="interactive_session ${HETZNER_SERVER_IP}"

# Install, configure, launch
install_agent "gptme" "pip install gptme 2>/dev/null || pip3 install gptme" "$RUN"
verify_agent "gptme" "command -v gptme && gptme --version" "pip install gptme" "$RUN"
get_or_prompt_api_key
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "gptme") || exit 1
inject_env_vars_cb "$RUN" "$UPLOAD" \
    "OPENROUTER_API_KEY=$OPENROUTER_API_KEY"
launch_session "Hetzner server" "$SESSION" "source ~/.zshrc && gptme -m openrouter/${MODEL_ID}"
