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
    exec bun run "$SCRIPT_DIR/../cli/src/aws/main.ts" zeroclaw "$@"
fi

# Remote — fall back to bash implementation
eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"

log_info "ZeroClaw on AWS Lightsail"
echo ""
log_warn "Note: ZeroClaw is built from Rust source and may take 5-10 minutes to compile."
echo ""

agent_install() {
    install_agent "ZeroClaw" \
        "curl -LsSf https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/install.sh | bash -s -- --install-rust --install-system-deps" \
        cloud_run
}

agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ZEROCLAW_PROVIDER=openrouter"
}

agent_configure() {
    cloud_run 'source ~/.spawnrc 2>/dev/null; export PATH="$HOME/.cargo/bin:$PATH"; zeroclaw onboard --api-key "${OPENROUTER_API_KEY}" --provider openrouter'
}

agent_launch_cmd() {
    echo 'source ~/.cargo/env 2>/dev/null; source ~/.spawnrc 2>/dev/null; zeroclaw agent'
}

spawn_agent "ZeroClaw" "zeroclaw" "aws"
