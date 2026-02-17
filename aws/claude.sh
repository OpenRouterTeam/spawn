#!/bin/bash
set -eo pipefail

# Source common functions - try local file first, fall back to remote
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# shellcheck source=aws/lib/common.sh
if [[ -f "${SCRIPT_DIR}/lib/common.sh" ]]; then
    source "${SCRIPT_DIR}/lib/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/aws/lib/common.sh)"
fi

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

spawn_agent "Claude Code"
