#!/bin/bash
# shellcheck disable=SC2154
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=aws-lightsail/lib/common.sh

if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws-lightsail/lib/common.sh)"
fi

log_info "NanoClaw on AWS Lightsail"
echo ""

# 1. Ensure AWS CLI is configured
ensure_aws_cli

# 2. Generate + register SSH key
ensure_ssh_key

# 3. Get instance name and create server
SERVER_NAME=$(get_server_name)
create_server "${SERVER_NAME}"

# 4. Wait for SSH and cloud-init
verify_server_connectivity "${LIGHTSAIL_SERVER_IP}"
wait_for_cloud_init "${LIGHTSAIL_SERVER_IP}" 60

# 5. Install Node.js deps and clone nanoclaw
log_step "Installing tsx..."
run_server "${LIGHTSAIL_SERVER_IP}" "source ~/.bashrc && bun install -g tsx"

log_step "Cloning and building nanoclaw..."
run_server "${LIGHTSAIL_SERVER_IP}" "git clone https://github.com/gavrielc/nanoclaw.git ~/nanoclaw && cd ~/nanoclaw && npm install && npm run build"
log_info "NanoClaw installed"

# 6. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# 7. Inject environment variables into ~/.zshrc
log_step "Setting up environment variables..."

inject_env_vars_ssh "${LIGHTSAIL_INSTANCE_IP}" upload_file run_server \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api"

# 8. Create nanoclaw .env file
log_step "Configuring nanoclaw..."

DOTENV_TEMP=$(mktemp)
cat > "${DOTENV_TEMP}" << EOF
ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}
EOF

upload_file "${LIGHTSAIL_SERVER_IP}" "${DOTENV_TEMP}" "/home/ubuntu/nanoclaw/.env"

echo ""
log_info "Lightsail instance setup completed successfully!"
log_info "Instance: ${SERVER_NAME} (IP: ${LIGHTSAIL_SERVER_IP})"
echo ""

# 9. Start nanoclaw
log_step "Starting nanoclaw..."
log_warn "You will need to scan a WhatsApp QR code to authenticate."
echo ""
interactive_session "${LIGHTSAIL_SERVER_IP}" "cd ~/nanoclaw && source ~/.zshrc && npm run dev"
