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

log_info "ZeroClaw on Hetzner Cloud"
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

spawn_agent "ZeroClaw" "zeroclaw" "hetzner"
