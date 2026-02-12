#!/bin/bash
set -eo pipefail

# Security Review Team Service — Single Cycle (Dual-Mode)
# Triggered by trigger-server.ts via GitHub Actions
#
# RUN_MODE=pr       — 2-agent security review for a specific PR (10 min)
# RUN_MODE=schedule — proactive scan of recent commits on main (15 min)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

# --- Run mode detection ---
SPAWN_ISSUE="${SPAWN_ISSUE:-}"
SPAWN_REASON="${SPAWN_REASON:-manual}"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"

# Validate SPAWN_ISSUE is a positive integer to prevent command injection
if [[ -n "${SPAWN_ISSUE}" ]] && [[ ! "${SPAWN_ISSUE}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: SPAWN_ISSUE must be a positive integer, got: '${SPAWN_ISSUE}'" >&2
    exit 1
fi

if [[ -n "${SPAWN_ISSUE}" ]]; then
    RUN_MODE="pr"
    PR_NUM="${SPAWN_ISSUE}"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-pr-${PR_NUM}"
    TEAM_NAME="spawn-security-pr-${PR_NUM}"
    CYCLE_TIMEOUT=600   # 10 min for PR reviews
else
    RUN_MODE="schedule"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-scan"
    TEAM_NAME="spawn-security-scan"
    CYCLE_TIMEOUT=900   # 15 min for scheduled scans
fi

LOG_FILE="/home/sprite/spawn/.docs/${TEAM_NAME}.log"
PROMPT_FILE=""

# Ensure .docs directory exists
mkdir -p "$(dirname "${LOG_FILE}")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] [${RUN_MODE}] $*" | tee -a "${LOG_FILE}"
}

# Cleanup function — runs on normal exit, SIGTERM, and SIGINT
cleanup() {
    # Guard against re-entry (SIGTERM trap calls exit, which fires EXIT trap again)
    if [[ -n "${_cleanup_done:-}" ]]; then return; fi
    _cleanup_done=1

    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."

    cd "${REPO_ROOT}" 2>/dev/null || true

    # Prune worktrees and clean up only OUR worktree base
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true

    # Clean up prompt and PID files
    rm -f "${PROMPT_FILE:-}" 2>/dev/null || true
    rm -f "${CLAUDE_PID_FILE:-}" 2>/dev/null || true

    log "=== Cycle Done (exit_code=${exit_code}) ==="
    exit $exit_code
}

trap cleanup EXIT SIGTERM SIGINT

log "=== Starting ${RUN_MODE} cycle ==="
log "Working directory: ${REPO_ROOT}"
log "Team name: ${TEAM_NAME}"
log "Worktree base: ${WORKTREE_BASE}"
log "Timeout: ${CYCLE_TIMEOUT}s"
if [[ "${RUN_MODE}" == "pr" ]]; then
    log "PR: #${PR_NUM}"
fi

# Fetch latest refs (read-only, safe for concurrent runs)
log "Fetching latest refs..."
git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true

# Launch Claude Code with mode-specific prompt
log "Launching ${RUN_MODE} cycle..."

PROMPT_FILE=$(mktemp /tmp/security-prompt-XXXXXX.md)

if [[ "${RUN_MODE}" == "pr" ]]; then
    # --- PR mode: 2-agent security review ---
    cat > "${PROMPT_FILE}" << PR_PROMPT_EOF
You are the Team Lead for a security review of PR #${PR_NUM} on the spawn codebase.

## Target PR

Review PR #${PR_NUM} for security issues.

First, fetch the PR details:
\`\`\`bash
gh pr view ${PR_NUM} --repo OpenRouterTeam/spawn
gh pr diff ${PR_NUM} --repo OpenRouterTeam/spawn
gh pr view ${PR_NUM} --repo OpenRouterTeam/spawn --json files --jq '.files[].path'
\`\`\`

## Time Budget

This cycle MUST complete within 8 minutes. This is a HARD deadline.

- At the 5-minute mark, stop new work and wrap up
- At the 7-minute mark, send shutdown_request to all agents
- At 8 minutes, force shutdown

## Team Structure

Create these teammates:

1. **code-reviewer** (Sonnet)
   - Fetch the full PR diff: \`gh pr diff ${PR_NUM} --repo OpenRouterTeam/spawn\`
   - Review every changed file for security issues:
     * **Command injection**: unquoted variables in shell commands, unsafe eval/heredoc, unsanitized input in bash
     * **Credential leaks**: hardcoded API keys, tokens, passwords; secrets logged to stdout; credentials in committed files
     * **Path traversal**: unsanitized file paths, directory escape via ../
     * **XSS/injection**: unsafe HTML rendering, prototype pollution, SQL injection, template injection
     * **Unsafe patterns**: use of \`eval\`, \`source <()\`, unvalidated redirects, TOCTOU races
     * **curl|bash safety**: broken source/eval fallback patterns, missing integrity checks
     * **macOS bash 3.x compat**: echo -e, source <(), ((var++)) with set -e, local in subshells, set -u
   - Classify each finding as CRITICAL, HIGH, MEDIUM, or LOW
   - Report findings to the team lead with file paths and line numbers

2. **test-verifier** (Haiku)
   - Get the list of changed files: \`gh pr view ${PR_NUM} --repo OpenRouterTeam/spawn --json files --jq '.files[].path'\`
   - For each changed .sh file:
     * Run \`bash -n FILE\` to check syntax
     * Verify it starts with \`#!/bin/bash\` and \`set -eo pipefail\`
     * Verify the local-or-remote source fallback pattern is used (not bare \`source ./lib/...\`)
     * Check for macOS bash 3.x incompatibilities (echo -e, source <(), etc.)
   - For changed .ts files:
     * Run \`bun test\` to verify tests pass
   - Report results to the team lead

## Review Decision

After both agents report back, make the final decision:

### If CRITICAL or HIGH issues found:
1. Post a **requesting-changes** review on the PR:
   \`\`\`bash
   gh pr review ${PR_NUM} --repo OpenRouterTeam/spawn --request-changes --body "REVIEW_BODY"
   \`\`\`
   Include all CRITICAL/HIGH findings with file paths, line numbers, and remediation suggestions.

2. If SLACK_WEBHOOK is set, send a Slack notification:
   \`\`\`bash
   PR_TITLE=\$(gh pr view ${PR_NUM} --repo OpenRouterTeam/spawn --json title --jq '.title')
   PR_URL="https://github.com/OpenRouterTeam/spawn/pull/${PR_NUM}"
   curl -s -X POST "\${SLACK_WEBHOOK}" -H 'Content-Type: application/json' \\
     -d "{\"text\":\":warning: Security concern on PR #${PR_NUM}: \${PR_TITLE} — [summary of top concern] — \${PR_URL}\"}"
   \`\`\`
   (The SLACK_WEBHOOK env var is: ${SLACK_WEBHOOK:-NOT_SET})

### If only MEDIUM/LOW issues or no issues:
1. Post an **approving** review on the PR:
   \`\`\`bash
   gh pr review ${PR_NUM} --repo OpenRouterTeam/spawn --approve --body "REVIEW_BODY"
   \`\`\`
   Include any MEDIUM/LOW findings as informational notes.

### Review body format:
\`\`\`
## Security Review

**Verdict**: [APPROVED / CHANGES REQUESTED]

### Findings
- [SEVERITY] file:line — description

### Tests
- bash -n: [PASS/FAIL]
- bun test: [PASS/FAIL/N/A]
- curl|bash pattern: [OK/MISSING]
- macOS compat: [OK/ISSUES]

---
*Automated security review by spawn security team*
\`\`\`

## Workflow

1. Create the team with TeamCreate
2. Fetch PR details and diff
3. Spawn code-reviewer and test-verifier in parallel
4. Monitor teammates (poll TaskList, sleep 15 between checks)
5. Collect results from both agents
6. Post the review (approve or request-changes)
7. If concerns found and SLACK_WEBHOOK is set, send Slack notification
8. Shutdown all teammates
9. Exit

## CRITICAL: Monitoring Loop

**Spawning teammates is the BEGINNING of your job, not the end.** After spawning all teammates, you MUST actively monitor them. Your session ENDS the moment you produce a response with no tool call. To stay alive, you MUST ALWAYS include at least one tool call in every response.

Required pattern:
1. Spawn teammates via Task tool
2. Poll loop:
   a. Run TaskList to check status
   b. If messages received, process them
   c. If no messages yet, run Bash("sleep 15") then loop back
3. Once both agents report, make review decision
4. Post review and optional Slack notification
5. Shutdown teammates and exit

## Safety Rules

- NEVER approve a PR with CRITICAL findings
- If unsure about a finding, flag it as MEDIUM and note the uncertainty
- Always include file paths and line numbers in findings
- Do not modify any code — this is review only

Begin now. Review PR #${PR_NUM}.
PR_PROMPT_EOF

else
    # --- Schedule mode: proactive scan of recent commits ---
    cat > "${PROMPT_FILE}" << 'SCHEDULE_PROMPT_EOF'
You are the Team Lead for a proactive security scan of the spawn codebase.

## Mission

Scan recent commits on main for security issues. This is NOT a PR review — just an audit.

## Time Budget

This cycle MUST complete within 10 minutes. This is a HARD deadline.

## Steps

1. Get recent commits: `git log --oneline -20 origin/main`
2. For each commit in the last 24 hours, review the diff: `git show COMMIT_SHA`
3. Scan all .sh files for:
   - Command injection (unquoted variables, unsafe eval)
   - Credential handling (hardcoded keys, logged secrets)
   - curl|bash safety (source/eval patterns)
   - macOS bash 3.x compatibility
4. Scan all .ts files for:
   - XSS, prototype pollution
   - Unsafe eval, unsanitized input
5. Run `bun test` to verify test suite passes
6. Run `bash -n` on all .sh files

## Output

Print a summary report of findings. If CRITICAL issues are found, create a GitHub issue:
```bash
gh issue create --repo OpenRouterTeam/spawn --title "Security: [description]" --body "BODY" --label "security"
```

No PR reviews in schedule mode — just scan and report.

Begin now.
SCHEDULE_PROMPT_EOF
fi

# Add grace period: pr=5min, schedule=5min beyond the prompt timeout
if [[ "${RUN_MODE}" == "pr" ]]; then
    HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))   # 10 + 5 = 15 min
else
    HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))   # 15 + 5 = 20 min
fi

log "Hard timeout: ${HARD_TIMEOUT}s"

# Activity watchdog: kill claude if no output for IDLE_TIMEOUT seconds.
IDLE_TIMEOUT=600  # 10 minutes of silence = hung

# Run claude in background so we can monitor output activity.
CLAUDE_PID_FILE=$(mktemp /tmp/claude-pid-XXXXXX)
( claude -p "$(cat "${PROMPT_FILE}")" --output-format stream-json --verbose &
  echo $! > "${CLAUDE_PID_FILE}"
  wait
) 2>&1 | tee -a "${LOG_FILE}" &
PIPE_PID=$!
sleep 2  # let claude start and write its PID

# Kill claude and its full process tree reliably
kill_claude() {
    local cpid
    cpid=$(cat "${CLAUDE_PID_FILE}" 2>/dev/null)
    if [[ -n "${cpid}" ]] && kill -0 "${cpid}" 2>/dev/null; then
        log "Killing claude (pid=${cpid}) and its process tree"
        pkill -TERM -P "${cpid}" 2>/dev/null || true
        kill -TERM "${cpid}" 2>/dev/null || true
        sleep 5
        pkill -KILL -P "${cpid}" 2>/dev/null || true
        kill -KILL "${cpid}" 2>/dev/null || true
    fi
    kill "${PIPE_PID}" 2>/dev/null || true
}

# Watchdog loop: check log file growth and detect session completion
LAST_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
LOG_START_SIZE="${LAST_SIZE}"
IDLE_SECONDS=0
WALL_START=$(date +%s)
SESSION_ENDED=false

while kill -0 "${PIPE_PID}" 2>/dev/null; do
    sleep 10
    CURR_SIZE=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
    WALL_ELAPSED=$(( $(date +%s) - WALL_START ))

    # Check if the stream-json "result" event has been emitted (session complete).
    if [[ "${SESSION_ENDED}" = false ]] && tail -c +"$((LOG_START_SIZE + 1))" "${LOG_FILE}" 2>/dev/null | grep -q '"type":"result"'; then
        SESSION_ENDED=true
        log "Session ended (result event detected) — waiting 30s for cleanup then killing"
        sleep 30
        kill_claude
        break
    fi

    if [[ "${CURR_SIZE}" -eq "${LAST_SIZE}" ]]; then
        IDLE_SECONDS=$((IDLE_SECONDS + 10))
        if [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
            log "Watchdog: no output for ${IDLE_SECONDS}s — killing hung process"
            kill_claude
            break
        fi
    else
        IDLE_SECONDS=0
        LAST_SIZE="${CURR_SIZE}"
    fi

    # Hard wall-clock timeout as final safety net
    if [[ "${WALL_ELAPSED}" -ge "${HARD_TIMEOUT}" ]]; then
        log "Hard timeout: ${WALL_ELAPSED}s elapsed — killing process"
        kill_claude
        break
    fi
done

wait "${PIPE_PID}" 2>/dev/null
CLAUDE_EXIT=$?

if [[ "${CLAUDE_EXIT}" -eq 0 ]] || [[ "${SESSION_ENDED}" = true ]]; then
    log "Cycle completed successfully"

    # Create checkpoint
    log "Creating checkpoint..."
    sprite-env checkpoint create --comment "security ${RUN_MODE} cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true
elif [[ "${IDLE_SECONDS}" -ge "${IDLE_TIMEOUT}" ]]; then
    log "Cycle killed by activity watchdog (no output for ${IDLE_TIMEOUT}s)"

    log "Creating checkpoint for partial work..."
    sprite-env checkpoint create --comment "security ${RUN_MODE} cycle hung (watchdog kill)" 2>&1 | tee -a "${LOG_FILE}" || true
elif [[ "${CLAUDE_EXIT}" -eq 124 ]]; then
    log "Cycle timed out after ${HARD_TIMEOUT}s — killed by hard timeout"

    log "Creating checkpoint for partial work..."
    sprite-env checkpoint create --comment "security ${RUN_MODE} cycle timed out (partial)" 2>&1 | tee -a "${LOG_FILE}" || true
else
    log "Cycle failed (exit_code=${CLAUDE_EXIT})"
fi

# Note: cleanup (worktree prune, prompt file removal, final log) handled by trap
