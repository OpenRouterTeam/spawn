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

# Push → PR → self-review (NO merging — merging is handled externally)
# Usage: push_and_create_pr BRANCH_NAME PR_TITLE PR_BODY
push_and_create_pr() {
    local branch_name="$1"
    local pr_title="$2"
    local pr_body="$3"

    # Check there are actual commits to push
    if [[ -z "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]]; then
        log "push_and_create_pr: No commits to push on ${branch_name}"
        return 0
    fi

    git push -u origin "${branch_name}" 2>&1 | tee -a "${LOG_FILE}" || {
        log "push_and_create_pr: Push failed for ${branch_name}"
        return 1
    }

    local pr_url=""
    pr_url=$(gh pr create \
        --title "${pr_title}" \
        --body "${pr_body}" \
        --base main --head "${branch_name}" 2>/dev/null) || true

    if [[ -z "${pr_url:-}" ]]; then
        log "push_and_create_pr: PR creation failed for ${branch_name}"
        return 1
    fi

    log "push_and_create_pr: PR created: ${pr_url}"

    # Extract PR number from URL
    local pr_number=""
    pr_number=$(printf '%s' "${pr_url}" | grep -oE '[0-9]+$') || true

    if [[ -n "${pr_number}" ]]; then
        # Self-review: add a comment summarizing the changes
        gh pr review "${pr_number}" --repo OpenRouterTeam/spawn --comment \
            --body "Self-review by QA cycle: ${pr_title}. Automated change -- tests were run before submission.\n\n-- qa/cycle" \
            2>&1 | tee -a "${LOG_FILE}" || true

        # Label for external review
        gh pr edit "${pr_number}" --repo OpenRouterTeam/spawn --add-label "needs-team-review" \
            2>&1 | tee -a "${LOG_FILE}" || true

        log "push_and_create_pr: Self-reviewed and labeled PR #${pr_number} (not merging — awaiting external review)"
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

# Clean up stale qa/readme-update-* branches on remote (from Phase 4)
REMOTE_README_BRANCHES=$(git branch -r --list 'origin/qa/readme-update-*' | sed 's|origin/||' | tr -d ' ') || true
for branch in $REMOTE_README_BRANCHES; do
    if [[ -n "$branch" ]]; then
        git push origin --delete "$branch" 2>&1 | tee -a "${LOG_FILE}" && log "Deleted stale README branch: $branch" || true
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
            gh pr close "$pr_num" --comment "Auto-closing: stale QA PR from a previous cycle.

-- qa/cycle" 2>&1 | tee -a "${LOG_FILE}" || true
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

        # Separate auth failures from code failures
        NON_AUTH_FAILED_CLOUDS=""
        STALE_KEY_PROVIDERS=""
        AUTH_PATTERN="401|403|[Uu]nauthorized|[Ff]orbidden|[Ii]nvalid.*(token|key|api)|[Aa]ccess.denied|[Aa]uthentication.failed"

        for cloud in ${RECORD_FAILED_CLOUDS}; do
            error_output=$(sed -n "/Recording ${cloud}/,/Recording \|━━━ \|Results:/p" "${RECORD_OUTPUT}" | head -50 || true)

            if printf '%s' "${error_output}" | grep -iqE "${AUTH_PATTERN}"; then
                log "Phase 1: Auth failure for ${cloud} — key is stale, skipping fix agent"
                if type invalidate_cloud_key &>/dev/null; then
                    invalidate_cloud_key "${cloud}"
                    while IFS= read -r var_name; do
                        [[ -n "${var_name}" ]] && unset "${var_name}" 2>/dev/null || true
                    done <<< "$(get_cloud_env_vars "${cloud}")"
                fi
                STALE_KEY_PROVIDERS="${STALE_KEY_PROVIDERS} ${cloud}"
            else
                NON_AUTH_FAILED_CLOUDS="${NON_AUTH_FAILED_CLOUDS} ${cloud}"
            fi
        done
        NON_AUTH_FAILED_CLOUDS=$(printf '%s' "${NON_AUTH_FAILED_CLOUDS}" | sed 's/^ //')
        STALE_KEY_PROVIDERS=$(printf '%s' "${STALE_KEY_PROVIDERS}" | sed 's/^ //')

        if [[ -n "${STALE_KEY_PROVIDERS}" ]]; then
            log "Phase 1: Stale keys detected: ${STALE_KEY_PROVIDERS}"
        fi

        # Spawn ONE agent per non-auth failed cloud (10 min each, one attempt only)
        RECORD_FIX_PIDS=""
        for cloud in ${NON_AUTH_FAILED_CLOUDS}; do
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

This likely means the cloud provider's API has changed. Investigate thoroughly and fix.

## Investigation Steps (follow in order):

1. **Check the provider's documentation:**
   - Search for \"${cloud} API documentation\" or visit the provider's developer docs
   - Look for recent API changelog or breaking changes announcements
   - Note any version changes, deprecated endpoints, or new required headers

2. **Understand the current implementation:**
   - Read ${cloud}/lib/common.sh to see how API calls are currently made
   - Read test/record.sh to understand the recording flow (get_endpoints, call_api)
   - Identify which specific API endpoint is failing from the error output

3. **Test the API manually (if possible):**
   - Try calling the failing endpoint with curl to see the actual response
   - Check if authentication headers have changed (API key format, Bearer tokens, etc.)
   - Verify the endpoint URL is still correct (base URL changes, versioning)
   - Compare the actual API response format with what the code expects

4. **Check for common issues:**
   - Has the base URL changed? (e.g., api.provider.com → api.v2.provider.com)
   - Are there new required headers? (Content-Type, User-Agent, API version)
   - Has the response schema changed? (different field names, nested structures)
   - Are there new rate limits or authentication requirements?

5. **Fix the lib/common.sh API functions:**
   - Update endpoint URLs, headers, or request format to match current API
   - Preserve backward compatibility where possible
   - Add comments explaining what changed and why

6. **Test your fix:**
   - Run: bash test/record.sh ${cloud}
   - Verify all endpoints record successfully
   - Check that response formats are correct

7. **Syntax check and commit:**
   - Run: bash -n ${cloud}/lib/common.sh
   - Commit with a clear message explaining what API change you fixed

Only modify ${cloud}/lib/common.sh and test/record.sh if the recording infrastructure needs updating." \
                    2>&1 | tee -a "${LOG_FILE}" || true

                # Check for changes (uncommitted OR committed by the agent)
                has_uncommitted=$(git status --porcelain 2>/dev/null)
                has_commits=$(git log origin/main..HEAD --oneline 2>/dev/null)

                if [[ -n "$has_uncommitted" ]] && bash -n "${cloud}/lib/common.sh" 2>/dev/null; then
                    git add "${cloud}/lib/common.sh" "test/record.sh" 2>/dev/null || true
                    git commit -m "$(printf 'fix: Update %s API integration for recording\n\nAgent: qa-record-fixer\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>' "${cloud}")" || true
                fi

                # Push, PR, and merge with retry on stale main
                push_and_create_pr "${branch_name}" \
                    "fix: Update ${cloud} API for fixture recording" \
                    "Automated fix from QA cycle. API recording was failing for ${cloud}." || true
            ) &
            RECORD_FIX_PIDS="${RECORD_FIX_PIDS} $!"
        done

        # Wait for record-fix agents
        for pid in ${RECORD_FIX_PIDS}; do
            wait "$pid" 2>/dev/null || true
        done

        # Clean up worktrees
        for cloud in ${NON_AUTH_FAILED_CLOUDS}; do
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
            run_with_timeout 900 \
                claude -p "Fix the failing mock tests for cloud '${cloud}' in the spawn codebase.

Failing scripts: ${failing_scripts}

Error context from test run:
${error_context}

## Investigation & Fix Process (be thorough):

1. **Understand the test infrastructure:**
   - Read test/mock.sh to see how mocking works (curl interception, fixture matching)
   - Read ${cloud}/lib/common.sh to understand the cloud's API primitives
   - Check test/fixtures/${cloud}/ to see what API responses are mocked

2. **For EACH failing script, investigate the root cause:**
   - Read the failing script (${cloud}/<agent>.sh)
   - Identify which API calls are being made
   - Check if the script is making API calls that aren't mocked in test/fixtures/${cloud}/
   - Look for missing fixtures, incorrect API endpoint URLs, or changed function signatures

3. **Check the cloud provider's current API (if needed):**
   - If the script seems correct but fixtures seem outdated, check the provider's API docs
   - Compare fixture responses with current API documentation
   - Look for API changes: new required parameters, different response formats, endpoint deprecations

4. **Common failure patterns to check:**
   - Missing test fixtures (script calls an API that has no mock response)
   - Wrong API endpoint format (e.g., /v2/servers vs /servers)
   - Missing authentication setup (API token not set in mock environment)
   - Incorrect assumptions about SSH connectivity in mock mode
   - Scripts calling commands that don't work in mock mode (ssh, scp without proper mocking)

5. **Fix the issues:**
   - Update scripts to work properly with the mock infrastructure
   - Add missing fixture files if needed (test/fixtures/${cloud}/<endpoint>.json)
   - Fix API calls to match current provider API
   - Ensure proper error handling for mock environment

6. **Test each fix incrementally:**
   - After fixing each script, run: RESULTS_FILE=/tmp/fix-test.txt bash test/mock.sh ${cloud}
   - Verify the specific script now passes
   - Check for regressions in other scripts

7. **Syntax check and commit:**
   - Run: bash -n on each modified script
   - Test final state: RESULTS_FILE=/tmp/fix-test.txt bash test/mock.sh ${cloud}
   - Commit all fixes with a message listing what was fixed and why

You can modify: scripts in ${cloud}/, test/fixtures/${cloud}/, and test/mock.sh if infrastructure updates are needed." \
                2>&1 | tee -a "${LOG_FILE}" || true

            # Always check for changes — agent may have committed partial fixes before timeout
            syntax_ok=true
            for script in ${failing_scripts}; do
                if [[ -f "${script}" ]] && ! bash -n "${script}" 2>/dev/null; then
                    log "Phase 3: Syntax check failed for ${script}"
                    syntax_ok=false
                fi
            done

            # Stage any uncommitted changes the agent left behind
            if [[ "$syntax_ok" == "true" ]] && [[ -n "$(git status --porcelain)" ]]; then
                git add ${failing_scripts} "${cloud}/lib/common.sh" "test/fixtures/${cloud}/" "test/mock.sh" 2>/dev/null || true
                git commit -m "$(cat <<FIXEOF
fix: Fix ${cloud} mock test failures (${fail_count} scripts)

Agent: qa-fixer
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
FIXEOF
                )" || true
            fi

            # Push, PR, and merge with retry on stale main
            push_and_create_pr "${branch_name}" \
                "fix: Fix ${cloud} mock test failures" \
                "Automated fix from QA cycle. ${fail_count} mock test(s) were failing for ${cloud}: ${failing_scripts}" || true
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

    # Commit + push if README changed (using PR workflow to avoid race conditions)
    if [[ -n "$(git diff --name-only README.md 2>/dev/null)" ]]; then
        # Create feature branch for README update (timestamped to avoid collisions)
        README_BRANCH="qa/readme-update-$(date +%s)"
        git checkout -b "${README_BRANCH}" 2>&1 | tee -a "${LOG_FILE}"

        git add README.md
        git commit -m "$(cat <<'EOF'
test: Update README matrix after QA cycle

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
        )" 2>&1 | tee -a "${LOG_FILE}" || true

        # Push, PR, and merge with retry on stale main
        push_and_create_pr "${README_BRANCH}" \
            "test: Update README matrix after QA cycle" \
            "Automated README update from QA cycle Phase 4. Test results updated in the matrix." || {
            log "Phase 4: PR creation failed, check for errors"
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
