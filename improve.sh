#!/bin/bash
# Continuous improvement loop for spawn using Claude Code Agent Teams
#
# Launches a team lead in delegate mode that coordinates teammates to
# expand the agents x clouds matrix in parallel.
#
# Each cycle the lead:
#   1. Reads manifest.json to find all gaps
#   2. Spawns teammates to fill gaps / discover new agents+clouds in parallel
#   3. Teammates implement, commit, and PR independently
#   4. Lead synthesizes and repeats
#
# Usage:
#   ./improve.sh                  # one team cycle (fill gaps + discover)
#   ./improve.sh --loop           # continuous cycles
#   ./improve.sh --single         # old single-agent mode (no teams)
#   ./improve.sh --discover       # focus on discovering new agents/clouds only

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

# Ensure agent teams feature is enabled
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# Parse current matrix state
get_matrix_summary() {
    python3 -c "
import json
m = json.load(open('$MANIFEST'))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
gaps = [k for k, v in m.get('matrix', {}).items() if v == 'missing']
impl = sum(1 for v in m['matrix'].values() if v == 'implemented')
total = len(agents) * len(clouds)
print(f'Matrix: {len(agents)} agents x {len(clouds)} clouds = {impl}/{total} implemented')
if gaps:
    print(f'Gaps ({len(gaps)}): {', '.join(gaps[:10])}')
else:
    print('Matrix is full — ready for discovery')
print(f'Agents: {', '.join(agents)}')
print(f'Clouds: {', '.join(clouds)}')
"
}

count_gaps() {
    python3 -c "
import json
m = json.load(open('$MANIFEST'))
print(sum(1 for v in m.get('matrix', {}).values() if v == 'missing'))
"
}

# Build the team prompt — this is what the lead sees
build_team_prompt() {
    local gaps
    gaps=$(count_gaps)
    local summary
    summary=$(get_matrix_summary)

    cat <<EOF
You are the lead of a spawn improvement team. Read CLAUDE.md and manifest.json first.

Current state:
$summary

Your job: coordinate teammates to expand the spawn matrix. Use delegate mode — do NOT implement anything yourself. Only coordinate.

## Team Strategy

### If there are gaps (missing matrix entries):
Spawn one teammate per gap (up to 5 at a time). Each teammate implements one {cloud}/{agent}.sh script by:
1. Reading the cloud's lib/common.sh for primitives
2. Reading the agent's script on another cloud for the install pattern
3. Writing the new script
4. Updating manifest.json to mark it "implemented"
5. Updating README.md with usage instructions
6. Committing with a descriptive message

### If the matrix is full:
Spawn 2-3 teammates in parallel:
- **Agent Scout**: research and add ONE new AI coding agent (must accept OPENAI_API_KEY or OPENROUTER_API_KEY env vars for OpenRouter injection). Add it to manifest.json, implement on 1-2 clouds, add "missing" entries for the rest.
- **Cloud Scout**: research and add ONE new cloud provider with REST API or CLI provisioning + SSH access. Create lib/common.sh, add to manifest.json, implement 1-2 agents, add "missing" entries.
- **Gap Filler**: after scouts commit, pick up the newly-created "missing" entries and implement them.

### Always:
- OpenRouter injection is MANDATORY in every script — see manifest.json agent.env fields
- Every script follows the pattern in CLAUDE.md
- Every commit includes the changes to manifest.json + README.md
- Require plan approval from teammates doing cloud provider work (lib/common.sh is critical)
- After all teammates finish, verify manifest.json has no gaps

## Rules for teammates:
- Each teammate works on DIFFERENT files — never two teammates on the same script
- Teammates should commit their own work (don't batch)
- If a teammate finishes early, they should self-claim the next unblocked task
- Use \`bash -n {file}\` to syntax-check before committing
EOF
}

# Build prompt for old single-agent mode
build_single_prompt() {
    local gap
    gap=$(python3 -c "
import json
m = json.load(open('$MANIFEST'))
for key, status in m.get('matrix', {}).items():
    if status == 'missing':
        print(key)
        break
")

    if [[ -n "$gap" && "$MODE" != "--discover" ]]; then
        local cloud="${gap%%/*}"
        local agent="${gap##*/}"
        cat <<EOF
Read CLAUDE.md and manifest.json. Implement "$cloud/$agent.sh":
1. Read $cloud/lib/common.sh for cloud primitives
2. Read an existing $agent.sh on another cloud for the install pattern
3. Write $cloud/$agent.sh combining the two
4. Update manifest.json to mark "$cloud/$agent" as "implemented"
5. Update README.md
6. Commit
OpenRouter injection is mandatory.
EOF
    else
        cat <<EOF
Read CLAUDE.md and manifest.json. The matrix is full. Discover and add ONE new agent or cloud provider. Implement it on at least one cloud. Update manifest.json and README.md. Commit.
EOF
    fi
}

run_team_cycle() {
    local prompt
    prompt=$(build_team_prompt)
    log_info "Launching agent team..."
    echo ""
    (cd "$REPO_ROOT" && claude -p "$prompt" --dangerously-skip-permissions)
    return $?
}

run_single_cycle() {
    local prompt
    prompt=$(build_single_prompt)
    log_info "Launching single agent..."
    echo ""
    (cd "$REPO_ROOT" && claude --print -p "$prompt")
    return $?
}

# Main
log_info "Spawn Improvement System"
log_info "Mode: $MODE"
get_matrix_summary
echo ""

case "$MODE" in
    --loop)
        cycle=1
        while true; do
            log_info "=== Team Cycle $cycle ==="
            run_team_cycle || {
                log_error "Cycle $cycle failed, pausing 10s..."
                sleep 10
            }
            ((cycle++))
            log_info "Pausing 5s before next cycle..."
            sleep 5
        done
        ;;
    --single)
        run_single_cycle
        ;;
    --discover)
        MODE="--discover" run_team_cycle
        ;;
    *)
        run_team_cycle
        ;;
esac
