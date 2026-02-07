#!/bin/bash
# Continuous improvement loop for spawn
#
# Each iteration:
#   1. Reads manifest.json to find gaps
#   2. Launches Claude Code to fill one gap (or discover new agents/clouds)
#   3. Commits the result
#   4. Repeats
#
# Usage:
#   ./improve.sh              # run one cycle
#   ./improve.sh --loop       # run continuously until matrix is full
#   ./improve.sh --discover   # focus on discovering new agents/clouds

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$REPO_ROOT/manifest.json"
MODE="${1:-once}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[improve]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[improve]${NC} $1"; }
log_error() { echo -e "${RED}[improve]${NC} $1"; }

# Check prerequisites
if ! command -v claude &>/dev/null; then
    log_error "Claude Code is required. Install: curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    log_error "python3 is required for manifest parsing"
    exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
    log_error "manifest.json not found at $MANIFEST"
    exit 1
fi

# Get the next missing matrix entry
get_next_gap() {
    python3 -c "
import json
m = json.load(open('$MANIFEST'))
for key, status in m.get('matrix', {}).items():
    if status == 'missing':
        print(key)
        break
"
}

# Count missing entries
count_gaps() {
    python3 -c "
import json
m = json.load(open('$MANIFEST'))
print(sum(1 for v in m.get('matrix', {}).values() if v == 'missing'))
"
}

# Build the prompt for Claude Code
build_fill_prompt() {
    local gap="$1"
    local cloud="${gap%%/*}"
    local agent="${gap##*/}"

    cat <<EOF
Read CLAUDE.md and manifest.json to understand the project.

Your task: implement the missing script "$cloud/$agent.sh"

This means creating a spawn script that provisions a $cloud server and installs $agent on it with OpenRouter credentials.

Steps:
1. Read the existing $cloud/lib/common.sh to understand the cloud primitives available
2. Read an existing $agent.sh on another cloud (check sprite/$agent.sh or hetzner/$agent.sh) to understand the agent's install/config steps
3. Write $cloud/$agent.sh combining the two
4. Update manifest.json to mark "$cloud/$agent" as "implemented"
5. Update README.md with usage instructions for this combination
6. Commit the changes

Follow the patterns in CLAUDE.md exactly. OpenRouter environment injection is mandatory.
EOF
}

build_discover_prompt() {
    cat <<EOF
Read CLAUDE.md and manifest.json to understand the project.

Your task: discover and add ONE new agent or cloud provider to the spawn matrix.

For a new AGENT:
- Search for popular open-source AI coding agents, CLI tools, or dev assistants
- It must be installable via a single command (curl, npm, pip, etc.)
- It must accept API keys via environment variables (so we can inject OpenRouter)
- Add it to manifest.json with full metadata
- Add "missing" matrix entries for all existing clouds
- Implement it on at least one cloud
- Update README.md

For a new CLOUD:
- Look for cloud providers with simple REST APIs or CLIs for server provisioning
- Must support SSH access and cloud-init (or equivalent userdata)
- Must have pay-per-hour or pay-per-minute pricing
- Create the cloud's lib/common.sh with all primitives
- Add it to manifest.json
- Add "missing" matrix entries for all existing agents
- Implement at least one agent on it
- Update README.md

Pick whichever (agent or cloud) you think adds the most value. Commit when done.
EOF
}

run_cycle() {
    local gap=$(get_next_gap)
    local gaps=$(count_gaps)

    if [[ -n "$gap" && "$MODE" != "--discover" ]]; then
        log_info "Found gap: $gap ($gaps total missing)"
        log_warn "Launching Claude Code to implement $gap..."
        echo ""

        local prompt=$(build_fill_prompt "$gap")
        (cd "$REPO_ROOT" && claude --print -p "$prompt")
        return $?
    elif [[ "$gaps" -eq 0 && "$MODE" != "--discover" ]]; then
        log_info "Matrix is full! Switching to discovery mode."
        local prompt=$(build_discover_prompt)
        (cd "$REPO_ROOT" && claude --print -p "$prompt")
        return $?
    else
        log_info "Discovery mode: looking for new agents or clouds..."
        local prompt=$(build_discover_prompt)
        (cd "$REPO_ROOT" && claude --print -p "$prompt")
        return $?
    fi
}

# Main
log_info "Spawn Improvement Loop"
log_info "Mode: $MODE"
log_info "Gaps: $(count_gaps) missing matrix entries"
echo ""

case "$MODE" in
    --loop)
        cycle=1
        while true; do
            log_info "=== Cycle $cycle ==="
            run_cycle || {
                log_error "Cycle $cycle failed, pausing 10s..."
                sleep 10
            }
            ((cycle++))
            log_info "Pausing 5s before next cycle..."
            sleep 5
        done
        ;;
    --discover)
        run_cycle
        ;;
    *)
        run_cycle
        ;;
esac
