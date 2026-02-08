#!/bin/bash
# Continuous improvement loop for spawn using Claude Code Agent Teams
#
# Discovery priorities:
#   1. Clouds/sandboxes > agents (bias toward new compute targets)
#   2. Agents must have real community buzz (HN, Reddit, GitHub stars)
#   3. Check repo issues for user requests
#   4. Fill matrix gaps from prior discovery
#
# Usage:
#   ./improve.sh                  # one team cycle
#   ./improve.sh --loop           # continuous cycles
#   ./improve.sh --single         # single-agent mode (no teams)

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${REPO_ROOT}/manifest.json"
MODE="${1:-once}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { printf "${GREEN}[improve]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[improve]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[improve]${NC} %s\n" "$1"; }

# Check prerequisites
if ! command -v claude &>/dev/null; then
    log_error "Claude Code is required. Install: curl -fsSL https://claude.ai/install.sh | bash"
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    log_error "python3 is required for manifest parsing"
    exit 1
fi

if [[ ! -f "${MANIFEST}" ]]; then
    log_error "manifest.json not found at ${MANIFEST}"
    exit 1
fi

export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

get_matrix_summary() {
    python3 -c "
import json
m = json.load(open('${MANIFEST}'))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
gaps = [k for k, v in m.get('matrix', {}).items() if v == 'missing']
impl = sum(1 for v in m['matrix'].values() if v == 'implemented')
total = len(agents) * len(clouds)
print(f'Matrix: {len(agents)} agents x {len(clouds)} clouds = {impl}/{total} implemented')
if gaps:
    print(f'Gaps ({len(gaps)}): {\", \".join(gaps[:10])}')
else:
    print('Matrix is full — ready for discovery')
print(f'Agents: {\", \".join(agents)}')
print(f'Clouds: {\", \".join(clouds)}')
"
}

count_gaps() {
    python3 -c "
import json
m = json.load(open('${MANIFEST}'))
print(sum(1 for v in m.get('matrix', {}).values() if v == 'missing'))
"
}

build_team_prompt() {
    local summary
    summary=$(get_matrix_summary)

    cat <<'PROMPT_EOF'
You are the lead of the spawn improvement team. Read CLAUDE.md and manifest.json first.

Current state:
PROMPT_EOF
    echo "${summary}"
    cat <<'PROMPT_EOF'

Your job: coordinate teammates to expand the spawn matrix. Use delegate mode — do NOT implement anything yourself. Only coordinate, review, and synthesize.

## Priority Order

1. **Fill gaps first** — if manifest.json has "missing" entries, fill them before discovering
2. **Clouds/sandboxes over agents** — we want MORE places to run, not more agents
3. **Agents only if community demands it** — see discovery rules below
4. **Check repo issues** — users may have requested specific agents or clouds

## Phase 1: Fill Gaps

If there are "missing" entries in the matrix, spawn one teammate per gap (up to 5). Each implements one {cloud}/{agent}.sh by reading the cloud's lib/common.sh + the agent's script on another cloud.

## Phase 2: Discovery (when matrix is full)

Spawn these teammates in parallel:

### Cloud Scout (PRIORITY — spawn 2 of these)
Research and add NEW cloud/sandbox providers. Focus on:
- Container/sandbox platforms (like E2B, Modal, Fly.io — fast, developer-friendly)
- GPU clouds (CoreWeave, RunPod, Vast.ai, Together AI)
- Regional/niche clouds with simple APIs (OVH, Scaleway, UpCloud)
- Any provider with a REST API or CLI for provisioning + SSH or exec access

For each candidate, verify:
- Has a public API or CLI for creating instances/containers
- Supports SSH, exec, or console access to the created environment
- Has pay-per-hour or pay-per-second pricing
- Is actually available (not waitlisted/invite-only)

### Agent Scout (spawn 1, only if justified)
Research new AI coding agents, BUT only add one if there's REAL community demand:

**Search these sources for buzz:**
- Search Hacker News (https://hn.algolia.com/api/v1/search?query=...) for the agent name — look for posts with 50+ points
- Search Reddit r/LocalLLaMA, r/MachineLearning, r/ChatGPT for the agent — look for posts with 100+ upvotes
- Check the agent's GitHub repo — must have 1000+ stars
- Search Twitter/X for the agent name + "coding agent" or "AI agent"

**Only add the agent if:**
- It's installable via a single command (npm, pip, curl)
- It accepts API keys via env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY)
- It has genuine community excitement (not just a press release)
- It's NOT already in manifest.json

### Issue Responder (spawn 1)
Check the repo's GitHub issues for user requests:
- Run: `gh issue list --repo OpenRouterTeam/spawn --state open --limit 20`
- Look for issues requesting specific agents or cloud providers
- If a request is actionable, implement it
- Comment on the issue with the PR link when done
- If a request is already implemented, close the issue with a comment

### Gap Filler (spawn remaining)
After scouts commit new entries, pick up the newly-created "missing" matrix entries and implement them.

## Git Workflow (CRITICAL)

Every teammate MUST follow this workflow. NO exceptions.

### Before starting work:
```bash
git checkout main && git pull --rebase origin main
```

### For each unit of work:
1. Create a feature branch: `git checkout -b {descriptive-name}`
2. Do the work, commit
3. Push: `git push -u origin {branch-name}`
4. Create PR: `gh pr create --title "..." --body "..."`
5. Merge immediately: `gh pr merge --squash`
6. Switch back: `git checkout main && git pull --rebase origin main`
7. Delete branch: `git push origin --delete {branch-name}`

### NEVER:
- Push directly to main
- Leave branches hanging after merge
- Work on a stale checkout — always pull latest main before each unit of work

## Rules for ALL teammates:
- Read CLAUDE.md Shell Script Rules before writing ANY code
- OpenRouter injection is MANDATORY in every script
- `bash -n {file}` syntax-check before committing
- Each teammate works on DIFFERENT files
- Each unit of work gets its own branch → PR → merge → cleanup
- Update manifest.json and the cloud's README.md
- NEVER revert prior macOS/curl-bash compatibility fixes
PROMPT_EOF
}

build_single_prompt() {
    local gap
    gap=$(python3 -c "
import json
m = json.load(open('${MANIFEST}'))
for key, status in m.get('matrix', {}).items():
    if status == 'missing':
        print(key)
        break
")

    if [[ -n "${gap}" ]]; then
        local cloud="${gap%%/*}"
        local agent="${gap##*/}"
        cat <<EOF
Read CLAUDE.md and manifest.json. Implement "${cloud}/${agent}.sh":
1. Read ${cloud}/lib/common.sh for cloud primitives
2. Read an existing ${agent}.sh on another cloud for the install pattern
3. Write ${cloud}/${agent}.sh combining the two
4. Update manifest.json to mark "${cloud}/${agent}" as "implemented"
5. Update the cloud's README.md
6. bash -n syntax check
7. Commit
OpenRouter injection is mandatory. Follow CLAUDE.md Shell Script Rules.
EOF
    else
        cat <<'EOF'
Read CLAUDE.md and manifest.json. The matrix is full.

Your priority: find a NEW cloud/sandbox provider to add. Search for container platforms,
GPU clouds, or regional providers with REST APIs. Create lib/common.sh, add to manifest,
implement 2-3 agents, add "missing" entries for the rest.

Only add a new AGENT if you find one with real community buzz:
- 1000+ GitHub stars
- 50+ point Hacker News posts (search https://hn.algolia.com/api/v1/search?query=AGENT)
- Active Reddit discussion in r/LocalLLaMA or r/MachineLearning

Also check `gh issue list --repo OpenRouterTeam/spawn --state open` for user requests.

Follow CLAUDE.md Shell Script Rules. Commit when done.
EOF
    fi
}

cleanup_between_cycles() {
    log_info "Cleaning up between cycles..."

    # Ensure we're on main and up to date
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    # Delete merged remote branches (not main)
    local merged_branches
    merged_branches=$(git branch -r --merged origin/main | grep -v 'main' | grep 'origin/' | sed 's|origin/||' | tr -d ' ')
    for branch in $merged_branches; do
        if [[ -n "$branch" && "$branch" != "main" ]]; then
            git push origin --delete "$branch" 2>/dev/null && log_info "Deleted merged branch: $branch" || true
        fi
    done

    # Delete local branches that are merged
    git branch --merged main | grep -v 'main' | grep -v '^\*' | xargs -r git branch -d 2>/dev/null || true

    log_info "Cleanup complete"
}

run_team_cycle() {
    # Always start fresh from latest main
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    local prompt
    prompt=$(build_team_prompt)
    log_info "Launching agent team..."
    echo ""
    claude -p "${prompt}" --dangerously-skip-permissions
    return $?
}

run_single_cycle() {
    cd "${REPO_ROOT}"
    git checkout main 2>/dev/null || true
    git pull --rebase origin main 2>/dev/null || true

    local prompt
    prompt=$(build_single_prompt)
    log_info "Launching single agent..."
    echo ""
    claude --print -p "${prompt}"
    return $?
}

# Main
log_info "Spawn Improvement System"
log_info "Mode: ${MODE}"
cd "${REPO_ROOT}"
git checkout main 2>/dev/null || true
git pull --rebase origin main 2>/dev/null || true
get_matrix_summary
echo ""

case "${MODE}" in
    --loop)
        cycle=1
        while true; do
            log_info "=== Team Cycle ${cycle} ==="
            run_team_cycle || {
                log_error "Cycle ${cycle} failed, pausing 10s..."
                sleep 10
            }
            # Clean up merged branches and sync main between cycles
            cleanup_between_cycles
            cycle=$((cycle + 1))
            log_info "Pausing 5s before next cycle..."
            sleep 5
        done
        ;;
    --single)
        run_single_cycle
        ;;
    *)
        run_team_cycle
        ;;
esac
