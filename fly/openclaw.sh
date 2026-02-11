#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/lib/common.sh" ]]; then
    source "$SCRIPT_DIR/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly/lib/common.sh)"
fi

log_info "OpenClaw on Fly.io"
echo ""

# 1. Ensure flyctl CLI and API token
ensure_fly_cli
ensure_fly_token

# 2. Get app name and create machine
SERVER_NAME=$(get_server_name)
create_server "$SERVER_NAME"

# 3. Install base tools
wait_for_cloud_init

# 4. Install openclaw via bun
log_step "Installing openclaw..."
run_server "source ~/.bashrc && bun install -g openclaw"
log_info "OpenClaw installed"

# 5. Get OpenRouter API key
echo ""
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    log_info "Using OpenRouter API key from environment"
else
    OPENROUTER_API_KEY=$(get_openrouter_api_key_oauth 5180)
fi

# Get model preference
MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Openclaw") || exit 1

# 6. Inject environment variables into shell config
log_step "Setting up environment variables..."

inject_env_vars_fly \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
    "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
    "PATH=\$HOME/.bun/bin:\$PATH"

# 7. Configure openclaw
log_step "Configuring openclaw..."

run_server "rm -rf ~/.openclaw && mkdir -p ~/.openclaw"

# Generate a random gateway token
GATEWAY_TOKEN=$(openssl rand -hex 16)

OPENCLAW_CONFIG_TEMP=$(mktemp)
chmod 600 "$OPENCLAW_CONFIG_TEMP"
printf '{\n  "env": {\n    "OPENROUTER_API_KEY": %s\n  },\n  "gateway": {\n    "mode": "local",\n    "auth": {\n      "token": %s\n    }\n  },\n  "agents": {\n    "defaults": {\n      "model": {\n        "primary": "openrouter/%s"\n      }\n    }\n  }\n}\n' "$(json_escape "${OPENROUTER_API_KEY}")" "$(json_escape "${GATEWAY_TOKEN}")" "${MODEL_ID}" > "$OPENCLAW_CONFIG_TEMP"

upload_file "$OPENCLAW_CONFIG_TEMP" "/root/.openclaw/openclaw.json"
rm "$OPENCLAW_CONFIG_TEMP"

echo ""
log_info "Fly.io machine setup completed successfully!"
log_info "App: $SERVER_NAME (Machine ID: $FLY_MACHINE_ID)"
echo ""

# 8. Start openclaw gateway in background and launch TUI
log_step "Starting openclaw..."
run_server "source ~/.zshrc && nohup openclaw gateway > /tmp/openclaw-gateway.log 2>&1 &"
sleep 2
interactive_session "source ~/.zshrc && openclaw tui"
