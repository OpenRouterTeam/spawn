#!/bin/bash
set -eo pipefail

# Continuous Refactoring Team Service
# Spawns a Claude Code agent team to maintain and improve the spawn codebase

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

LOG_FILE="/home/sprite/spawn/.docs/refactor.log"
TEAM_NAME="spawn-refactor"
CYCLE=0

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

log "=== Starting Continuous Refactoring Team Service ==="
log "Working directory: ${SCRIPT_DIR}"
log "Team name: ${TEAM_NAME}"
log "Log file: ${LOG_FILE}"

# Main loop
while true; do
    CYCLE=$((CYCLE + 1))
    log ""
    log "=== Refactoring Cycle ${CYCLE} ==="

    # Ensure we're on latest main
    log "Syncing with origin/main..."
    git fetch origin main 2>&1 | tee -a "${LOG_FILE}" || true
    git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

    # Launch Claude Code with team instructions
    log "Launching refactoring team..."

    # Create the prompt for Claude Code
    PROMPT="You are the Team Lead for the spawn continuous refactoring service (Cycle ${CYCLE}).

Your mission: Spawn a team of specialized agents to maintain and improve the spawn codebase autonomously.

## Team Structure

Create these teammates:

1. **security-auditor** (Sonnet)
   - Scan all .sh scripts for command injection, path traversal, credential leaks
   - Check TypeScript code for XSS, prototype pollution, unsafe eval
   - Review OpenRouter API key handling
   - Fix vulnerabilities immediately

2. **ux-engineer** (Sonnet)
   - Test end-to-end user flows (spawn cli → cloud → agent launch)
   - Improve error messages (make them actionable and clear)
   - Fix UX papercuts (confusing prompts, unclear help text, broken workflows)
   - Verify all usage examples in READMEs work

3. **complexity-hunter** (Haiku)
   - Find bash functions >50 lines or TypeScript functions >80 lines
   - Reduce cyclomatic complexity without breaking features
   - Extract repeated code patterns into shared utilities
   - Run tests after each refactoring to verify no regressions

4. **test-engineer** (Haiku)
   - Add missing tests for new features
   - Verify all bash scripts with shellcheck
   - Run 'bun test' and fix failures
   - Add integration tests for critical paths

5. **issue-triager** (Sonnet)
   - Run: gh issue list --repo OpenRouterTeam/spawn --state open --json number,title,body,createdAt
   - For each issue:
     * Read the error log provided
     * Attempt to reproduce locally
     * If reproducible: assign to relevant teammate to fix
     * If not reproducible or user error: close with helpful comment
     * If feature request: label as 'enhancement' and close (point to discussions)
   - Respond within 1 hour of issue creation

## Workflow

1. Create the team with TeamCreate
2. Create tasks using TaskCreate for each area:
   - Security scan of all scripts
   - UX test of main user flows
   - Complexity reduction in top 5 longest functions
   - Test coverage for recent changes
   - GitHub issue triage
3. Spawn teammates with Task tool using subagent_type='general-purpose'
4. Assign tasks to teammates using TaskUpdate
5. Monitor teammate progress via their messages
6. Create Sprite checkpoint after successful changes: sprite-env checkpoint create --comment 'Description'
7. When cycle completes, summarize what was fixed/improved

## Safety Rules

- ALWAYS create Sprite checkpoint BEFORE risky changes
- One logical change per commit
- Run tests after every change
- If 3 consecutive test failures, pause and investigate
- Never break existing functionality
- Focus on high-impact, low-risk improvements

## Priority Scoring

Score tasks: (Impact × Confidence) / Risk
- Impact: 1-10 (how much better will this make spawn?)
- Confidence: 1-10 (how sure are you it's correct?)
- Risk: 1-10 (how likely to break things?)

Target autonomous score: >30

Begin Cycle ${CYCLE} now. Spawn the team and start working."

    # Run Claude Code with the prompt
    if echo "${PROMPT}" | claude -p "$(cat)" 2>&1 | tee -a "${LOG_FILE}"; then
        log "✓ Cycle ${CYCLE} completed successfully"

        # Commit any changes made during the cycle
        if [[ -n "$(git status --porcelain)" ]]; then
            log "Committing changes from cycle ${CYCLE}..."
            git add -A
            git commit -m "refactor: Automated improvements from cycle ${CYCLE}

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>" 2>&1 | tee -a "${LOG_FILE}" || true

            # Push to main
            git push origin main 2>&1 | tee -a "${LOG_FILE}" || true
        fi

        # Create checkpoint
        log "Creating checkpoint after cycle ${CYCLE}..."
        sprite-env checkpoint create --comment "Refactor cycle ${CYCLE} complete" 2>&1 | tee -a "${LOG_FILE}" || true

        # Brief pause before next cycle
        log "Pausing 30 seconds before next cycle..."
        sleep 30
    else
        log "✗ Cycle ${CYCLE} failed, pausing 5 minutes before retry..."
        sleep 300
    fi
done
