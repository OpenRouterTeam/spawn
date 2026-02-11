#!/bin/bash
set -eo pipefail

# QA Cycle Service — Daily automated test + fix + README update
# Triggered by trigger-server.ts via GitHub Actions
#
# Phase 1: Record fixtures (bash test/record.sh allsaved)
# Phase 2: Run mock tests → results file
# Phase 3: Spawn agents to fix failures
# Phase 4: Re-run tests → update README → commit + push

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
cd "${REPO_ROOT}"

SPAWN_REASON="${SPAWN_REASON:-manual}"
WORKTREE_BASE="/tmp/spawn-worktrees/qa"
LOG_FILE="${REPO_ROOT}/.docs/qa-cycle.log"
CYCLE_TIMEOUT=2700  # 45 min total

# Results files
RESULTS_PHASE2="/tmp/spawn-qa-results.txt"
RESULTS_PHASE4="/tmp/spawn-qa-results-retry.txt"

# Ensure directories
mkdir -p "$(dirname "${LOG_FILE}")" "${WORKTREE_BASE}"

log() {
    printf '[%s] [qa] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*" | tee -a "${LOG_FILE}"
}

cleanup() {
    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."
    cd "${REPO_ROOT}" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true
    rm -f "${RESULTS_PHASE2}" "${RESULTS_PHASE4}" "/tmp/spawn-qa-record-output.txt" 2>/dev/null || true
    log "=== QA Cycle Done (exit_code=${exit_code}) ==="
    exit $exit_code
}

trap cleanup EXIT SIGTERM SIGINT

log "=== Starting QA cycle (reason=${SPAWN_REASON}) ==="
log "Repo root: ${REPO_ROOT}"
log "Timeout: ${CYCLE_TIMEOUT}s"

# Track start time for total cycle timeout
CYCLE_START=$(date +%s)

check_timeout() {
    local now elapsed
    now=$(date +%s)
    elapsed=$((now - CYCLE_START))
    if [[ "$elapsed" -ge "$CYCLE_TIMEOUT" ]]; then
        log "TIMEOUT: Cycle exceeded ${CYCLE_TIMEOUT}s, stopping"
        return 1
    fi
    return 0
}

# ============================================================
# Pre-cycle cleanup (stale branches, worktrees, PRs from prior runs)
# ============================================================
log "Pre-cycle cleanup..."

git fetch --prune origin 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

# Clean stale worktrees
git worktree prune 2>&1 | tee -a "${LOG_FILE}" || true
if [[ -d "${WORKTREE_BASE}" ]]; then
    rm -rf "${WORKTREE_BASE}" 2>&1 | tee -a "${LOG_FILE}" || true
    log "Removed stale ${WORKTREE_BASE} directory"
fi
mkdir -p "${WORKTREE_BASE}"

# Delete merged qa/* remote branches
MERGED_BRANCHES=$(git branch -r --merged origin/main | grep 'origin/qa/' | sed 's|origin/||' | tr -d ' ') || true
for branch in $MERGED_BRANCHES; do
    if [[ -n "$branch" ]]; then
        git push origin --delete "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted merged branch: $branch" || true
    fi
done

# Delete stale local qa/* branches
LOCAL_QA_BRANCHES=$(git branch --list 'qa/*' | tr -d ' *') || true
for branch in $LOCAL_QA_BRANCHES; do
    if [[ -n "$branch" ]]; then
        git branch -D "$branch" 2>&1 | tee -a "${LOG_FILE}" || true
    fi
done

# Close stale qa PRs (open > 2 hours)
STALE_PRS=$(gh pr list --state open --label '' --json number,headRefName,updatedAt \
    --jq '[.[] | select(.headRefName | startswith("qa/")) | select(.updatedAt < (now - 7200 | todate)) | .number] | .[]' 2>/dev/null) || true
for pr_num in $STALE_PRS; do
    if [[ -n "$pr_num" ]]; then
        PR_MERGEABLE=$(gh pr view "$pr_num" --json mergeable --jq '.mergeable' 2>/dev/null) || PR_MERGEABLE="UNKNOWN"
        if [[ "$PR_MERGEABLE" == "MERGEABLE" ]]; then
            log "Merging stale QA PR #${pr_num}..."
            gh pr merge "$pr_num" --squash --delete-branch 2>&1 | tee -a "${LOG_FILE}" || true
        else
            log "Closing unmergeable stale QA PR #${pr_num}..."
            gh pr close "$pr_num" --comment "Auto-closing: stale QA PR from a previous cycle." 2>&1 | tee -a "${LOG_FILE}" || true
        fi
    fi
done

# Re-sync after any merges from cleanup
git fetch origin main 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

log "Pre-cycle cleanup complete"

# ============================================================
# Phase 1: Record fixtures
# ============================================================
log "=== Phase 1: Record fixtures ==="

RECORD_OUTPUT="/tmp/spawn-qa-record-output.txt"
rm -f "${RECORD_OUTPUT}"

RECORD_EXIT=0
bash test/record.sh allsaved 2>&1 | tee -a "${LOG_FILE}" | tee "${RECORD_OUTPUT}" || RECORD_EXIT=$?

if [[ "${RECORD_EXIT}" -eq 0 ]]; then
    log "Phase 1: All fixtures recorded successfully"
else
    log "Phase 1: Some fixture recordings failed, identifying failed clouds..."

    # Parse which clouds had failures from record.sh output
    # record.sh prints "━━━ Recording {cloud} ━━━" then "fail" lines for errors
    RECORD_FAILED_CLOUDS=""
    current_cloud=""
    while IFS= read -r line; do
        # Strip ANSI color codes
        clean=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g')
        case "$clean" in
            *"Recording "*" ━━━"*)
                current_cloud=$(printf '%s' "$clean" | sed 's/.*Recording //; s/ ━━━.*//')
                ;;
            *"fail "*)
                if [[ -n "${current_cloud}" ]]; then
                    case " ${RECORD_FAILED_CLOUDS} " in
                        *" ${current_cloud} "*) ;;  # already tracked
                        *) RECORD_FAILED_CLOUDS="${RECORD_FAILED_CLOUDS} ${current_cloud}" ;;
                    esac
                fi
                ;;
        esac
    done < "${RECORD_OUTPUT}"
    RECORD_FAILED_CLOUDS=$(printf '%s' "${RECORD_FAILED_CLOUDS}" | sed 's/^ //')

    if [[ -n "${RECORD_FAILED_CLOUDS}" ]]; then
        log "Phase 1: Failed clouds: ${RECORD_FAILED_CLOUDS}"

        # Spawn ONE agent per failed cloud to investigate (10 min each, one attempt only)
        RECORD_FIX_PIDS=""
        for cloud in ${RECORD_FAILED_CLOUDS}; do
            check_timeout || break

            # Extract error context for this cloud
            error_lines=$(sed -n "/Recording ${cloud}/,/Recording \|━━━ \|Results:/p" "${RECORD_OUTPUT}" | head -30 || true)

            log "Phase 1: Spawning agent to debug ${cloud} recording failure"
            worktree="${WORKTREE_BASE}/record-fix-${cloud}"
            branch_name="qa/record-fix-${cloud}"

            git worktree add "${worktree}" -b "${branch_name}" origin/main 2>&1 | tee -a "${LOG_FILE}" || {
                log "Phase 1: Could not create worktree for ${cloud}, skipping"
                continue
            }

            (
                cd "${worktree}"
                timeout --signal=TERM --kill-after=60 600 \
                    claude -p "The API fixture recording for cloud '${cloud}' is failing in test/record.sh.

Error output:
${error_lines}

This likely means the cloud provider's API has changed. Investigate and fix.

Instructions:
1. Read ${cloud}/lib/common.sh to understand the API wrapper functions
2. Read test/record.sh to see how recordings work (get_endpoints, call_api)
3. Check if the API endpoint URLs, auth headers, or response format changed
4. Fix the lib/common.sh API functions to match the current API
5. Test: bash test/record.sh ${cloud} (must succeed)
6. Run: bash -n ${cloud}/lib/common.sh to syntax check
7. Commit your fix

Only modify ${cloud}/lib/common.sh — do not change test/record.sh." \
                    2>&1 | tee -a "${LOG_FILE}" || true

                # Verify and push if changes were made
                if bash -n "${cloud}/lib/common.sh" 2>/dev/null && [[ -n "$(git status --porcelain)" ]]; then
                    git add "${cloud}/lib/common.sh"
                    git commit -m "$(printf 'fix: Update %s API integration for recording\n\nAgent: qa-record-fixer\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>' "${cloud}")" || true
                    git push -u origin "${branch_name}" || true
                    PR_URL=$(gh pr create \
                        --title "fix: Update ${cloud} API for fixture recording" \
                        --body "Automated fix from QA cycle. API recording was failing for ${cloud}." \
                        --base main --head "${branch_name}" 2>/dev/null) || true
                    if [[ -n "${PR_URL:-}" ]]; then
                        gh pr merge --squash --delete-branch 2>/dev/null || true
                    fi
                fi
            ) &
            RECORD_FIX_PIDS="${RECORD_FIX_PIDS} $!"
        done

        # Wait for record-fix agents
        for pid in ${RECORD_FIX_PIDS}; do
            wait "$pid" 2>/dev/null || true
        done

        # Clean up worktrees
        for cloud in ${RECORD_FAILED_CLOUDS}; do
            git worktree remove "${WORKTREE_BASE}/record-fix-${cloud}" 2>/dev/null || true
            git branch -D "qa/record-fix-${cloud}" 2>/dev/null || true
        done
        git worktree prune 2>/dev/null || true

        # Pull any merged fixes and re-record (ONE retry, no agents on second failure)
        git fetch origin main 2>&1 | tee -a "${LOG_FILE}" || true
        git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

        log "Phase 1: Re-recording after fixes (no agents on second failure)..."
        bash test/record.sh allsaved 2>&1 | tee -a "${LOG_FILE}" || {
            log "Phase 1: Re-record still has failures — continuing with existing fixtures"
        }
    fi
fi

rm -f "${RECORD_OUTPUT}"
check_timeout || exit 0

# ============================================================
# Phase 2: Run mock tests
# ============================================================
log "=== Phase 2: Run mock tests ==="

rm -f "${RESULTS_PHASE2}"
MOCK_EXIT=0
RESULTS_FILE="${RESULTS_PHASE2}" bash test/mock.sh 2>&1 | tee -a "${LOG_FILE}" || MOCK_EXIT=$?

if [[ -f "${RESULTS_PHASE2}" ]]; then
    TOTAL_TESTS=$(wc -l < "${RESULTS_PHASE2}" | tr -d ' ')
    PASS_COUNT=$(grep -c ':pass$' "${RESULTS_PHASE2}" || true)
    FAIL_COUNT=$(grep -c ':fail$' "${RESULTS_PHASE2}" || true)
    log "Phase 2: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${TOTAL_TESTS} total"
else
    log "Phase 2: No results file generated"
    FAIL_COUNT=0
fi

check_timeout || exit 0

# ============================================================
# Phase 3: Fix mock failures
# ============================================================
log "=== Phase 3: Fix failures ==="

if [[ "${FAIL_COUNT:-0}" -eq 0 ]]; then
    log "Phase 3: No failures to fix"
else
    # Collect failures
    FAILURES=""
    if [[ -f "${RESULTS_PHASE2}" ]]; then
        FAILURES=$(grep ':fail$' "${RESULTS_PHASE2}" | sed 's/:fail$//' || true)
    fi

    AGENT_PIDS=""
    for combo in $FAILURES; do
        check_timeout || break

        cloud=$(printf '%s' "$combo" | cut -d/ -f1)
        agent=$(printf '%s' "$combo" | cut -d/ -f2)
        script_path="${cloud}/${agent}.sh"
        worktree="${WORKTREE_BASE}/fix-${cloud}-${agent}"

        log "Phase 3: Spawning agent to fix ${script_path}"

        # Get error context from mock test output
        error_context=""
        if [[ -f "${LOG_FILE}" ]]; then
            error_context=$(grep -A 20 "test ${script_path}" "${LOG_FILE}" | tail -20 || true)
        fi

        # Create worktree for this fix
        branch_name="qa/fix-${cloud}-${agent}"
        git worktree add "${worktree}" -b "${branch_name}" origin/main 2>&1 | tee -a "${LOG_FILE}" || {
            log "Phase 3: Could not create worktree for ${combo}, skipping"
            continue
        }

        # Spawn Claude to fix the script (10 min timeout per agent)
        (
            cd "${worktree}"
            FIX_EXIT=0
            timeout --signal=TERM --kill-after=60 600 \
                claude -p "Fix the failing mock test for ${script_path} in the spawn codebase.

The script is at: ${worktree}/${script_path}

Error context from test run:
${error_context}

Instructions:
1. Read the failing script and understand what it does
2. Read test/mock.sh to understand how mock tests work
3. Fix the script so it passes mock tests
4. Run: RESULTS_FILE=/tmp/fix-test.txt bash test/mock.sh ${cloud} ${agent}
5. Verify it passes
6. Run: bash -n ${script_path} to syntax check

Only modify ${script_path} — do not change test infrastructure.
Commit your fix with a descriptive message." \
                2>&1 | tee -a "${LOG_FILE}" || FIX_EXIT=$?

            if [[ "${FIX_EXIT}" -eq 0 ]]; then
                # Verify syntax
                if bash -n "${script_path}" 2>/dev/null; then
                    # Check if there are changes to push
                    if [[ -n "$(git status --porcelain)" ]]; then
                        git add "${script_path}"
                        git commit -m "$(cat <<FIXEOF
fix: Fix ${script_path} mock test failure

Agent: qa-fixer
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
FIXEOF
                        )" || true
                        git push -u origin "${branch_name}" || true
                        # Create and merge PR
                        PR_URL=$(gh pr create \
                            --title "fix: Fix ${script_path} mock test" \
                            --body "Automated fix from QA cycle. Mock test was failing for ${cloud}/${agent}." \
                            --base main --head "${branch_name}" 2>/dev/null) || true
                        if [[ -n "${PR_URL:-}" ]]; then
                            gh pr merge --squash --delete-branch 2>/dev/null || true
                        fi
                    fi
                else
                    log "Phase 3: Syntax check failed for ${script_path}, discarding fix"
                fi
            fi
        ) &
        AGENT_PIDS="${AGENT_PIDS} $!"
    done

    # Wait for all fix agents to complete
    for pid in $AGENT_PIDS; do
        wait "$pid" 2>/dev/null || true
    done

    # Clean up worktrees
    for combo in $FAILURES; do
        cloud=$(printf '%s' "$combo" | cut -d/ -f1)
        agent=$(printf '%s' "$combo" | cut -d/ -f2)
        worktree="${WORKTREE_BASE}/fix-${cloud}-${agent}"
        branch_name="qa/fix-${cloud}-${agent}"
        git worktree remove "${worktree}" 2>/dev/null || true
        git branch -D "${branch_name}" 2>/dev/null || true
    done
    git worktree prune 2>/dev/null || true

    log "Phase 3: Fix agents complete"
fi

check_timeout || exit 0

# ============================================================
# Phase 4: Re-run mock tests + update README + push
# ============================================================
log "=== Phase 4: Re-run tests and update README ==="

# Pull any merged fixes
git fetch origin main 2>&1 | tee -a "${LOG_FILE}" || true
git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

rm -f "${RESULTS_PHASE4}"
RESULTS_FILE="${RESULTS_PHASE4}" bash test/mock.sh 2>&1 | tee -a "${LOG_FILE}" || true

if [[ -f "${RESULTS_PHASE4}" ]]; then
    RETRY_PASS=$(grep -c ':pass$' "${RESULTS_PHASE4}" || true)
    RETRY_FAIL=$(grep -c ':fail$' "${RESULTS_PHASE4}" || true)
    log "Phase 4: ${RETRY_PASS} passed, ${RETRY_FAIL} failed"

    python3 test/update-readme.py "${RESULTS_PHASE4}" 2>&1 | tee -a "${LOG_FILE}"

    # Commit + push if README changed
    if [[ -n "$(git diff --name-only README.md 2>/dev/null)" ]]; then
        git add README.md
        git commit -m "$(cat <<'EOF'
test: Update README matrix after QA cycle

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
        )" 2>&1 | tee -a "${LOG_FILE}" || true
        git push origin main 2>&1 | tee -a "${LOG_FILE}" || true
        log "Phase 4: README updated, committed, and pushed"
    else
        log "Phase 4: No README changes needed"
    fi
else
    log "Phase 4: No results file generated"
fi

# Final summary
log "=== QA Cycle Summary ==="
log "Phase 2: ${PASS_COUNT:-0} pass / ${FAIL_COUNT:-0} fail"
log "Phase 4: ${RETRY_PASS:-0} pass / ${RETRY_FAIL:-0} fail"
if [[ "${FAIL_COUNT:-0}" -gt 0 ]] && [[ "${RETRY_FAIL:-0}" -lt "${FAIL_COUNT:-0}" ]]; then
    FIXED=$(( ${FAIL_COUNT:-0} - ${RETRY_FAIL:-0} ))
    log "Fixed ${FIXED} failure(s) this cycle"
fi

# Create checkpoint if available
sprite-env checkpoint create --comment "QA cycle complete" 2>&1 | tee -a "${LOG_FILE}" || true

log "=== QA Cycle Complete ==="
