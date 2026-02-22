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
    exec bun run "$SCRIPT_DIR/../cli/src/aws/main.ts" claude "$@"
fi

# Remote — fall back to bash implementation
eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"

log_info "Claude Code on AWS Lightsail"
echo ""

agent_pre_provision() { prompt_github_auth; }
agent_install() { install_claude_code cloud_run; }
agent_env_vars() {
    generate_env_config \
        "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api" \
        "ANTHROPIC_AUTH_TOKEN=${OPENROUTER_API_KEY}" \
        "ANTHROPIC_API_KEY=" \
        "CLAUDE_CODE_SKIP_ONBOARDING=1" \
        "CLAUDE_CODE_ENABLE_TELEMETRY=0"
}
agent_configure() { setup_claude_code_config "${OPENROUTER_API_KEY}" cloud_upload cloud_run; }
agent_launch_cmd() { echo 'source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH; claude'; }

spawn_agent "Claude Code" "claude" "aws"
