#!/bin/bash
set -eo pipefail

# Security Review Team Service — Single Cycle (Tri-Mode)
# Triggered by trigger-server.ts via GitHub Actions
#
# RUN_MODE=pr       — 2-agent security review for a specific PR (10 min)
# RUN_MODE=hygiene  — stale PR cleanup + triage (reason=hygiene, 15 min)
# RUN_MODE=scan     — full repo security scan + issue filing (reason=schedule, 20 min)

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
elif [[ "${SPAWN_REASON}" == "hygiene" ]]; then
    RUN_MODE="hygiene"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-hygiene"
    TEAM_NAME="spawn-security-hygiene"
    CYCLE_TIMEOUT=900   # 15 min for PR hygiene
else
    RUN_MODE="scan"
    WORKTREE_BASE="/tmp/spawn-worktrees/security-scan"
    TEAM_NAME="spawn-security-scan"
    CYCLE_TIMEOUT=1200  # 20 min for full repo scan
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

1. **code-reviewer** (Opus)
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

2. **Merge the PR** (squash merge, delete branch):
   \`\`\`bash
   gh pr merge ${PR_NUM} --repo OpenRouterTeam/spawn --squash --delete-branch
   \`\`\`
   Merge if ALL of these are true:
   - Zero CRITICAL or HIGH findings from code-reviewer
   - All bash -n checks pass
   - All bun tests pass (or N/A)
   If merge fails (e.g. conflicts, branch protection), log the error and move on.

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

1. Create the team with TeamCreate (team_name="${TEAM_NAME}")
2. Create tasks with TaskCreate for each teammate's work
3. Fetch PR details and diff
4. Spawn teammates in parallel using Task tool (subagent_type='general-purpose', team_name="${TEAM_NAME}"):
   - code-reviewer (model=opus): security review of the diff
   - test-verifier (model=haiku): syntax/test verification
5. Assign tasks to teammates using TaskUpdate (set owner to teammate name)
6. Monitor teammates (poll TaskList, sleep 15 between checks)
7. Collect results from both agents via messages
8. Make the review decision:
   - If CRITICAL/HIGH → request changes + Slack notification
   - If MEDIUM/LOW or clean → approve AND merge (squash + delete branch)
9. Shutdown all teammates via SendMessage (type=shutdown_request)
10. Clean up with TeamDelete
11. Exit

## CRITICAL: Monitoring Loop

**Spawning teammates is the BEGINNING of your job, not the end.** After spawning all teammates, you MUST actively monitor them. Your session ENDS the moment you produce a response with no tool call. To stay alive, you MUST ALWAYS include at least one tool call in every response.

Required pattern:
1. Spawn teammates via Task tool (with team_name and name params)
2. Poll loop:
   a. Run TaskList to check status
   b. If messages received, process them
   c. If no messages yet, run Bash("sleep 15") then loop back
3. Once both agents report, make review decision
4. Post review and merge if no CRITICAL/HIGH findings
5. Send Slack notification if concerns found
6. Shutdown teammates and exit

## Safety Rules

- NEVER approve a PR with CRITICAL or HIGH findings
- Auto-merge PRs that have no CRITICAL/HIGH findings and all tests pass
- MEDIUM/LOW findings are informational — still approve and merge
- If unsure about a finding, flag it as MEDIUM and note the uncertainty
- Always include file paths and line numbers in findings
- Do not modify any code — this is review only

Begin now. Review PR #${PR_NUM}.
PR_PROMPT_EOF

elif [[ "${RUN_MODE}" == "hygiene" ]]; then
    # --- Hygiene mode: stale PR cleanup + triage ---
    cat > "${PROMPT_FILE}" << 'HYGIENE_PROMPT_EOF'
You are the Team Lead for a PR hygiene cycle on the spawn codebase.

## Mission

Go through ALL open PRs. For each one: review it, decide whether to close or keep, and take action. Also file issues for anything that needs follow-up.

## Time Budget

This cycle MUST complete within 12 minutes. This is a HARD deadline.

- At the 9-minute mark, stop new work and wrap up
- At the 11-minute mark, send shutdown_request to all agents
- At 12 minutes, force shutdown

## Team Structure

Create these teammates:

1. **pr-triager** (Opus)
   - List ALL open PRs: `gh pr list --repo OpenRouterTeam/spawn --state open --json number,title,updatedAt,author,mergeable,headRefName,labels`
   - For EACH open PR, evaluate:
     * **Staleness**: last updated > 48 hours ago? (use `updatedAt` field)
     * **Mergeable**: does it have merge conflicts? (`mergeable` field)
     * **CI status**: `gh pr checks NUMBER --repo OpenRouterTeam/spawn` — are checks passing?
     * **Review status**: does it have reviews? `gh pr view NUMBER --repo OpenRouterTeam/spawn --json reviews --jq '.reviews[].state'`
     * **Relevance**: read the diff (`gh pr diff NUMBER --repo OpenRouterTeam/spawn`) — is the change still relevant to the current codebase?
   - For each PR, take ONE of these actions:
     * **Close** (stale + conflicts + no activity):
       `gh pr close NUMBER --repo OpenRouterTeam/spawn --comment "Auto-closing: this PR has been stale for >48h with merge conflicts. The changes may no longer be relevant. Please reopen or create a fresh PR if still needed."`
       Then delete the branch: `gh pr view NUMBER --repo OpenRouterTeam/spawn --json headRefName --jq '.headRefName'` → `git push origin --delete BRANCH`
     * **Close with issue** (stale but has good ideas):
       Close the PR with a comment, then file a new issue capturing the intent:
       `gh issue create --repo OpenRouterTeam/spawn --title "Follow-up: [original PR intent]" --body "Original PR #NUMBER was auto-closed due to staleness. The approach had merit: [summary]. Needs a fresh implementation." --label "enhancement"`
     * **Request review** (looks good but needs eyes):
       `gh pr review NUMBER --repo OpenRouterTeam/spawn --comment --body "Automated triage: This PR looks viable but needs human review. [summary of what it does and any concerns]"`
       Add label: `gh pr edit NUMBER --repo OpenRouterTeam/spawn --add-label "needs-team-review"`
     * **Leave alone** (fresh, actively worked on): skip it
   - Report all actions taken to the team lead

2. **branch-cleaner** (Haiku)
   - List all remote branches: `git branch -r --format='%(refname:short) %(committerdate:unix)'`
   - For each branch (excluding main):
     * Check if there's an open PR: `gh pr list --head BRANCH --state open --json number`
     * If NO open PR and branch is stale (>48 hours): delete it `git push origin --delete BRANCH`
     * If open PR exists: leave it (pr-triager handles PRs)
   - Report summary: how many branches deleted, how many left

## Actions Summary

After both agents report, compile a summary:

### If any PRs were closed or issues filed, send a Slack notification:
```bash
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
if [ -n "$SLACK_WEBHOOK" ]; then
  curl -s -X POST "$SLACK_WEBHOOK" -H 'Content-Type: application/json' \
    -d '{"text":":broom: PR Hygiene cycle complete: [N PRs closed, M issues filed, K branches deleted]. See details in the workflow run."}'
fi
```

## Workflow

1. Create the team with TeamCreate (team_name="spawn-security-hygiene")
2. Create tasks with TaskCreate for each teammate's work
3. Spawn teammates in parallel using Task tool (subagent_type='general-purpose', team_name="spawn-security-hygiene"):
   - pr-triager (model=opus): review and triage all open PRs
   - branch-cleaner (model=haiku): clean up stale orphan branches
4. Assign tasks to teammates using TaskUpdate (set owner to teammate name)
5. Monitor teammates (poll TaskList, sleep 15 between checks)
6. Collect results from both agents via messages
7. Compile summary and send Slack notification
8. Shutdown all teammates via SendMessage (type=shutdown_request)
9. Clean up with TeamDelete
10. Exit

## CRITICAL: Monitoring Loop

**Spawning teammates is the BEGINNING of your job, not the end.** After spawning all teammates, you MUST actively monitor them. Your session ENDS the moment you produce a response with no tool call. To stay alive, you MUST ALWAYS include at least one tool call in every response.

Required pattern:
1. Spawn teammates via Task tool (with team_name and name params)
2. Poll loop:
   a. Run TaskList to check status
   b. If messages received, process them
   c. If no messages yet, run Bash("sleep 15") then loop back
3. Once both agents report, compile summary
4. Send Slack notification if actions were taken
5. Shutdown teammates and exit

## Safety Rules

- NEVER close a PR without posting a comment explaining why
- If a PR has recent activity (<24h), leave it alone regardless of other factors
- When filing follow-up issues, include the original PR number and a clear description
- Do not modify any code — this is triage only

Begin now. Start the PR hygiene cycle.
HYGIENE_PROMPT_EOF

    # Substitute SLACK_WEBHOOK in the hygiene prompt (it uses double-quote heredoc workaround)
    sed -i "s|\${SLACK_WEBHOOK:-}|${SLACK_WEBHOOK:-}|g" "${PROMPT_FILE}"

else
    # --- Scan mode: full repo security audit + issue filing ---
    cat > "${PROMPT_FILE}" << SCAN_PROMPT_EOF
You are the Team Lead for a full security scan of the spawn codebase.

## Mission

Perform a comprehensive security audit of the entire repository. File GitHub issues for anything you find. This is a proactive scan — not triggered by a PR.

## Time Budget

This cycle MUST complete within 15 minutes. This is a HARD deadline.

- At the 12-minute mark, stop new work and wrap up
- At the 14-minute mark, send shutdown_request to all agents
- At 15 minutes, force shutdown

## Team Structure

Create these teammates:

1. **shell-auditor** (Opus)
   - Scan ALL .sh files in the repo for security issues:
     * **Command injection**: unquoted variables in shell commands, unsafe eval/heredoc, unsanitized user input
     * **Credential leaks**: hardcoded API keys/tokens/passwords, secrets logged to stdout, credentials in committed files
     * **Path traversal**: unsanitized file paths, directory escape via ../
     * **Unsafe patterns**: use of \`eval\` with user input, \`source <()\`, unvalidated redirects, TOCTOU races
     * **curl|bash safety**: broken source/eval fallback patterns, missing error handling on remote fetches
     * **macOS bash 3.x compat**: echo -e, source <(), ((var++)) with set -e, local in subshells, set -u
     * **Permission issues**: world-readable credential files, insecure temp file creation
   - Run \`bash -n\` on every .sh file to catch syntax errors
   - Classify each finding as CRITICAL, HIGH, MEDIUM, or LOW
   - Report all findings with file paths and line numbers to the team lead

2. **code-auditor** (Opus)
   - Scan ALL .ts files for security issues:
     * **XSS/injection**: unsafe HTML rendering, unsanitized output, template injection
     * **Prototype pollution**: unsafe object merging, __proto__ access
     * **Unsafe eval**: eval(), Function(), vm.runInNewContext() with user input
     * **Dependency issues**: known vulnerable patterns, unsafe require/import
     * **Auth bypass**: missing auth checks, insecure token validation
     * **Information disclosure**: verbose error messages leaking internals, stack traces exposed
   - Run \`bun test\` to verify test suite passes
   - Check for any weird/unexpected changes by comparing key files against what they should contain:
     * \`shared/common.sh\` — should only contain shared utilities
     * \`manifest.json\` — should match expected agent/cloud matrix structure
     * \`.github/workflows/\` — should only contain expected workflow files
     * \`cli/src/\` — should only contain expected CLI source files
   - Report all findings with file paths and line numbers to the team lead

3. **drift-detector** (Haiku)
   - Check for unexpected changes or anomalies in the repo:
     * Files that shouldn't be committed: .env, credentials, private keys, .DS_Store
     * Unexpected binary files
     * Files with unusual permissions
     * Recent commits that look suspicious (unusual author, mass changes, obfuscated code)
     * Check \`git log --oneline -50 origin/main\` for any weird commit patterns
   - Verify \`.gitignore\` covers sensitive patterns
   - Check that gitignored files (start-*.sh, .docs/) are not accidentally tracked
   - Report any anomalies to the team lead

## Issue Filing

After all agents report, file GitHub issues for findings:

### CRITICAL/HIGH findings — file individual issues:
\`\`\`bash
gh issue create --repo OpenRouterTeam/spawn \\
  --title "Security: [brief description]" \\
  --body "## Security Finding

**Severity**: [CRITICAL/HIGH]
**File**: \`path/to/file:line\`
**Category**: [injection/credential-leak/path-traversal/etc.]

### Description
[Detailed description of the vulnerability]

### Remediation
[Specific steps to fix]

### Found by
Automated security scan (spawn security team)
" \\
  --label "security"
\`\`\`

### MEDIUM/LOW findings — file a single batch issue:
\`\`\`bash
gh issue create --repo OpenRouterTeam/spawn \\
  --title "Security: batch of medium/low findings from scan" \\
  --body "## Security Scan Results

[List all MEDIUM/LOW findings in a table]

| Severity | File | Description |
|----------|------|-------------|
| MEDIUM | path:line | description |
| LOW | path:line | description |

### Found by
Automated security scan (spawn security team)
" \\
  --label "security"
\`\`\`

### DEDUP: Before filing any issue, check if a similar issue already exists:
\`\`\`bash
gh issue list --repo OpenRouterTeam/spawn --state open --label "security" --json number,title --jq '.[].title'
\`\`\`
Do NOT file duplicate issues. If a similar issue exists, add a comment with updated findings instead.

### Drift/anomaly findings — file as issues:
\`\`\`bash
gh issue create --repo OpenRouterTeam/spawn \\
  --title "Repo hygiene: [description]" \\
  --body "[details]" \\
  --label "maintenance"
\`\`\`

## Slack Notification

After filing issues, send a summary to Slack:
\`\`\`bash
SLACK_WEBHOOK="${SLACK_WEBHOOK:-NOT_SET}"
if [ -n "\${SLACK_WEBHOOK}" ] && [ "\${SLACK_WEBHOOK}" != "NOT_SET" ]; then
  curl -s -X POST "\${SLACK_WEBHOOK}" -H 'Content-Type: application/json' \\
    -d '{"text":":shield: Security scan complete: [N critical, M high, K medium, L low] findings. [X issues filed]. See https://github.com/OpenRouterTeam/spawn/issues?q=label:security"}'
fi
\`\`\`

## Workflow

1. Create the team with TeamCreate (team_name="spawn-security-scan")
2. Create tasks with TaskCreate for each teammate's work
3. Spawn teammates in parallel using Task tool (subagent_type='general-purpose', team_name="spawn-security-scan"):
   - shell-auditor (model=opus): audit all .sh files
   - code-auditor (model=opus): audit all .ts files
   - drift-detector (model=haiku): check for anomalies and unexpected files
4. Assign tasks to teammates using TaskUpdate (set owner to teammate name)
5. Monitor teammates (poll TaskList, sleep 15 between checks)
6. Collect results from all agents via messages
7. Dedup check against existing issues
8. File new issues for novel findings
9. Send Slack summary
10. Shutdown all teammates via SendMessage (type=shutdown_request)
11. Clean up with TeamDelete
12. Exit

## CRITICAL: Monitoring Loop

**Spawning teammates is the BEGINNING of your job, not the end.** After spawning all teammates, you MUST actively monitor them. Your session ENDS the moment you produce a response with no tool call. To stay alive, you MUST ALWAYS include at least one tool call in every response.

Required pattern:
1. Spawn teammates via Task tool (with team_name and name params)
2. Poll loop:
   a. Run TaskList to check status
   b. If messages received, process them
   c. If no messages yet, run Bash("sleep 15") then loop back
3. Once all agents report, compile findings
4. Dedup check against existing issues
5. File new issues for novel findings
6. Send Slack summary
7. Shutdown teammates and exit

## Safety Rules

- Do not modify any code — this is audit only
- Always dedup against existing issues before filing
- Classify findings conservatively — if unsure, rate it one level higher
- Include specific file paths and line numbers in all findings
- For CRITICAL findings, always include a concrete remediation suggestion

Begin now. Start the full security scan.
SCAN_PROMPT_EOF

fi

# Add grace period: pr=5min, hygiene=5min, scan=5min beyond the prompt timeout
HARD_TIMEOUT=$((CYCLE_TIMEOUT + 300))

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
