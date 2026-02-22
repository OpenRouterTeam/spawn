#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, runs bundled aws.js (local or from GitHub release)

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# Local checkout — run from source
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../cli/src/aws/main.ts" ]]; then
    exec bun run "$SCRIPT_DIR/../cli/src/aws/main.ts" openclaw "$@"
fi

# Remote — fall back to bash implementation
eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"

log_info "OpenClaw on AWS Lightsail"
echo ""

AGENT_MODEL_PROMPT=1
AGENT_MODEL_DEFAULT="openrouter/auto"

agent_install() { install_agent "openclaw" "source ~/.bashrc && bun install -g openclaw" cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
}
agent_configure() { setup_openclaw_config "${OPENROUTER_API_KEY}" "${MODEL_ID}" cloud_upload cloud_run; }
agent_pre_launch() {
    start_openclaw_gateway cloud_run
    wait_for_openclaw_gateway cloud_run
}
agent_launch_cmd() { echo 'source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; openclaw tui'; }

spawn_agent "OpenClaw" "openclaw" "aws"
