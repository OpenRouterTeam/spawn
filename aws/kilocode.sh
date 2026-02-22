#!/bin/bash
# shellcheck disable=SC2154
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
    exec bun run "$SCRIPT_DIR/../cli/src/aws/main.ts" kilocode "$@"
fi

# Remote — fall back to bash implementation
eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"

log_info "Kilo Code on AWS Lightsail"
echo ""

agent_install() { install_agent "Kilo Code" "npm install -g @kilocode/cli" cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "KILO_PROVIDER_TYPE=openrouter" \
        "KILO_OPEN_ROUTER_API_KEY=${OPENROUTER_API_KEY}"
}
agent_launch_cmd() { echo 'source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; kilocode'; }

spawn_agent "Kilo Code" "kilocode" "aws"
