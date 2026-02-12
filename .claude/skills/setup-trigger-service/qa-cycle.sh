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

# macOS-compatible timeout: run command with a time limit
# Usage: run_with_timeout SECONDS COMMAND [ARGS...]
run_with_timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    local elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$elapsed" -ge "$secs" ]]; then
            kill "$pid" 2>/dev/null
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            return 124
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    wait "$pid" 2>/dev/null
}

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

# Robust push → PR → merge with retry on stale main
# Usage: push_and_merge_pr BRANCH_NAME PR_TITLE PR_BODY
push_and_merge_pr() {
    local branch_name="$1"
    local pr_title="$2"
    local pr_body="$3"
    local max_retries=3
    local attempt=0

    if [[ -z "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]]; then
        log "push_and_merge_pr: No commits to push on ${branch_name}"
        return 0
    fi

    git push -u origin "${branch_name}" 2>&1 | tee -a "${LOG_FILE}" || {
        log "push_and_merge_pr: Push failed for ${branch_name}"
        return 1
    }

    local pr_url=""
    pr_url=$(gh pr create \
        --title "${pr_title}" \
        --body "${pr_body}" \
        --base main --head "${branch_name}" 2>/dev/null) || true

    if [[ -z "${pr_url:-}" ]]; then
        log "push_and_merge_pr: PR creation failed for ${branch_name}"
        return 1
    fi

    log "push_and_merge_pr: PR created: ${pr_url}"

    while [[ "$attempt" -lt "$max_retries" ]]; do
        attempt=$((attempt + 1))

        if gh pr merge "${branch_name}" --squash --delete-branch 2>&1 | tee -a "${LOG_FILE}"; then
            log "push_and_merge_pr: Merged ${branch_name} (attempt ${attempt})"
            return 0
        fi

        log "push_and_merge_pr: Merge failed (attempt ${attempt}/${max_retries}), rebasing onto latest main..."

        git fetch origin main 2>/dev/null || true
        if git rebase origin/main 2>&1 | tee -a "${LOG_FILE}"; then
            git push --force-with-lease origin "${branch_name}" 2>&1 | tee -a "${LOG_FILE}" || true
            sleep 3
        else
            git rebase --abort 2>/dev/null || true
            log "push_and_merge_pr: Rebase failed for ${branch_name}, giving up"
            break
        fi
    done

    log "push_and_merge_pr: Could not merge ${branch_name} after ${max_retries} attempts, leaving PR open"
    return 1
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
# Phase 0: Key Preflight
# ============================================================
log "=== Phase 0: Key Preflight ==="

if [[ -f "${REPO_ROOT}/shared/key-request.sh" ]]; then
    source "${REPO_ROOT}/shared/key-request.sh"
    load_cloud_keys_from_config
    if [[ -n "${MISSING_KEY_PROVIDERS:-}" ]]; then
        log "Phase 0: Missing keys for: ${MISSING_KEY_PROVIDERS}"
        if [[ -n "${KEY_SERVER_URL:-}" ]]; then
            log "Phase 0: Requesting keys via key-server (will trigger email notification)"
            request_missing_cloud_keys
        else
            log "Phase 0: KEY_SERVER_URL not set — skipping email notification"
            log "Phase 0: Set KEY_SERVER_URL and KEY_SERVER_SECRET to enable email flow"
        fi
    else
        log "Phase 0: All cloud keys available"
    fi
else
    log "Phase 0: shared/key-request.sh not found, skipping key preflight"
fi

check_timeout || exit 0

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
                run_with_timeout 600 \
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
                    push_and_merge_pr "${branch_name}" \
                        "fix: Update ${cloud} API for fixture recording" \
                        "Automated fix from QA cycle. API recording was failing for ${cloud}." || true
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

    # Request fresh keys for stale providers (auth failures detected earlier)
    if [[ -n "${STALE_KEY_PROVIDERS:-}" ]] && type request_missing_cloud_keys &>/dev/null; then
        MISSING_KEY_PROVIDERS="${STALE_KEY_PROVIDERS}"
        log "Phase 1: Requesting fresh keys for stale providers: ${STALE_KEY_PROVIDERS}"
        request_missing_cloud_keys
        log "Phase 1: Key request sent (email notification will be sent if KEY_SERVER_URL is configured)"
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
    # Collect failures grouped by cloud (one agent per cloud, not per script)
    FAILURES=""
    FAILED_CLOUDS=""
    if [[ -f "${RESULTS_PHASE2}" ]]; then
        FAILURES=$(grep ':fail$' "${RESULTS_PHASE2}" | sed 's/:fail$//' || true)
        FAILED_CLOUDS=$(grep ':fail$' "${RESULTS_PHASE2}" | sed 's/:fail$//' | cut -d/ -f1 | sort -u || true)
    fi

    AGENT_PIDS=""
    for cloud in $FAILED_CLOUDS; do
        check_timeout || break

        # Collect all failing scripts for this cloud
        cloud_failures=$(printf '%s\n' $FAILURES | grep "^${cloud}/" || true)
        failing_scripts=""
        failing_agents=""
        error_context=""
        for combo in $cloud_failures; do
            agent=$(printf '%s' "$combo" | cut -d/ -f2)
            script_path="${cloud}/${agent}.sh"
            failing_scripts="${failing_scripts} ${script_path}"
            failing_agents="${failing_agents} ${agent}"
            if [[ -f "${LOG_FILE}" ]]; then
                ctx=$(grep -A 10 "test ${script_path}" "${LOG_FILE}" | tail -10 || true)
                if [[ -n "$ctx" ]]; then
                    error_context="${error_context}
--- ${script_path} ---
${ctx}
"
                fi
            fi
        done
        failing_scripts=$(printf '%s' "$failing_scripts" | sed 's/^ //')
        failing_agents=$(printf '%s' "$failing_agents" | sed 's/^ //')

        fail_count=$(printf '%s\n' $cloud_failures | wc -l | tr -d ' ')
        log "Phase 3: Spawning agent to fix ${fail_count} failing script(s) in ${cloud}"

        worktree="${WORKTREE_BASE}/fix-${cloud}"
        branch_name="qa/fix-${cloud}"

        git worktree add "${worktree}" -b "${branch_name}" origin/main 2>&1 | tee -a "${LOG_FILE}" || {
            log "Phase 3: Could not create worktree for ${cloud}, skipping"
            continue
        }

        # Spawn ONE Claude agent per cloud to fix all its failing scripts (15 min timeout)
        (
            cd "${worktree}"
            FIX_EXIT=0
            run_with_timeout 900 \
                claude -p "Fix the failing mock tests for cloud '${cloud}' in the spawn codebase.

Failing scripts: ${failing_scripts}

Error context from test run:
${error_context}

Instructions:
1. Read ${cloud}/lib/common.sh to understand the cloud's API functions
2. Read test/mock.sh to understand how mock tests work
3. For EACH failing script, read it and fix it so mock tests pass
4. Test each fix: RESULTS_FILE=/tmp/fix-test.txt bash test/mock.sh ${cloud}
5. Run: bash -n on each modified script to syntax check
6. Only modify scripts in ${cloud}/ — do not change test infrastructure
7. Commit all fixes together with a descriptive message" \
                2>&1 | tee -a "${LOG_FILE}" || FIX_EXIT=$?

            if [[ "${FIX_EXIT}" -eq 0 ]]; then
                # Verify syntax on all modified scripts
                syntax_ok=true
                for script in ${failing_scripts}; do
                    if [[ -f "${script}" ]] && ! bash -n "${script}" 2>/dev/null; then
                        log "Phase 3: Syntax check failed for ${script}"
                        syntax_ok=false
                    fi
                done

                if [[ "$syntax_ok" == "true" ]] && [[ -n "$(git status --porcelain)" ]]; then
                    git add ${failing_scripts} "${cloud}/lib/common.sh" 2>/dev/null || true
                    git commit -m "$(cat <<FIXEOF
fix: Fix ${cloud} mock test failures (${fail_count} scripts)

Agent: qa-fixer
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
FIXEOF
                    )" || true
                    push_and_merge_pr "${branch_name}" \
                        "fix: Fix ${cloud} mock test failures" \
                        "Automated fix from QA cycle. ${fail_count} mock test(s) were failing for ${cloud}: ${failing_scripts}" || true
                fi
            fi
        ) &
        AGENT_PIDS="${AGENT_PIDS} $!"
    done

    # Wait for all fix agents to complete
    for pid in $AGENT_PIDS; do
        wait "$pid" 2>/dev/null || true
    done

    # Clean up worktrees (one per cloud)
    for cloud in $FAILED_CLOUDS; do
        git worktree remove "${WORKTREE_BASE}/fix-${cloud}" 2>/dev/null || true
        git branch -D "qa/fix-${cloud}" 2>/dev/null || true
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

    # Commit + push if README changed (using PR workflow for safety)
    if [[ -n "$(git diff --name-only README.md 2>/dev/null)" ]]; then
        README_BRANCH="qa/readme-update-$(date +%s)"
        git checkout -b "${README_BRANCH}" 2>&1 | tee -a "${LOG_FILE}"

        git add README.md
        git commit -m "$(cat <<'EOF'
test: Update README matrix after QA cycle

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
        )" 2>&1 | tee -a "${LOG_FILE}" || true

        push_and_merge_pr "${README_BRANCH}" \
            "test: Update README matrix after QA cycle" \
            "Automated README update from QA cycle Phase 4. Test results updated in the matrix." || {
            log "Phase 4: PR merge failed, leaving PR open for manual review"
        }

        # Switch back to main and sync
        git checkout main 2>&1 | tee -a "${LOG_FILE}" || true
        git fetch origin main 2>&1 | tee -a "${LOG_FILE}" || true
        git reset --hard origin/main 2>&1 | tee -a "${LOG_FILE}" || true

        log "Phase 4: README updated via PR"
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
