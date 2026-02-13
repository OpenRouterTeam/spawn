#!/bin/bash
set -eo pipefail

# QA Dry Run — Same phases as qa-cycle.sh but NO GitHub interaction.
# Runs locally: records fixtures, mock tests, spawns fix agents, re-tests.
# Skips: git push, PRs, issues, remote branch cleanup, git reset --hard origin/main.
# Artifacts saved to .docs/qa-dry-run-latest/ for inspection.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "${REPO_ROOT}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
cd "${REPO_ROOT}"

SPAWN_REASON="${SPAWN_REASON:-manual}"
WORKTREE_BASE="/tmp/spawn-worktrees/qa-dry"
CYCLE_TIMEOUT=2700  # 45 min total

# Output directory for dry-run artifacts
DRY_OUTPUT_DIR="${REPO_ROOT}/.docs/qa-dry-run-latest"
rm -rf "${DRY_OUTPUT_DIR}"
mkdir -p "${DRY_OUTPUT_DIR}"

LOG_FILE="${DRY_OUTPUT_DIR}/qa-dry-run.log"

# Results files
RESULTS_PHASE2="/tmp/spawn-qa-dry-results.txt"
RESULTS_PHASE4="/tmp/spawn-qa-dry-results-retry.txt"

# Ensure directories
mkdir -p "$(dirname "${LOG_FILE}")" "${WORKTREE_BASE}"

log() {
    printf '[%s] [qa-dry] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*" | tee -a "${LOG_FILE}"
}

# Log what would happen in a real cycle
dry_log() {
    log "DRY_RUN: Would run: $*"
    printf '[would-run] %s\n' "$*" >> "${DRY_OUTPUT_DIR}/would-commit.txt"
}

cleanup() {
    local exit_code=$?
    log "Running cleanup (exit_code=${exit_code})..."
    cd "${REPO_ROOT}" 2>/dev/null || true
    git worktree prune 2>/dev/null || true
    rm -rf "${WORKTREE_BASE}" 2>/dev/null || true
    rm -f "${RESULTS_PHASE2}" "${RESULTS_PHASE4}" "/tmp/spawn-qa-dry-record-output.txt" 2>/dev/null || true
    # Save results files to output dir before deleting
    [[ -f "${RESULTS_PHASE2}" ]] && cp "${RESULTS_PHASE2}" "${DRY_OUTPUT_DIR}/results-phase2.txt" 2>/dev/null || true
    [[ -f "${RESULTS_PHASE4}" ]] && cp "${RESULTS_PHASE4}" "${DRY_OUTPUT_DIR}/results-phase4.txt" 2>/dev/null || true
    log "=== QA Dry Run Done (exit_code=${exit_code}) ==="
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

log "=== Starting QA Dry Run ==="
log "Repo root: ${REPO_ROOT}"
log "Output dir: ${DRY_OUTPUT_DIR}"
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
# Pre-cycle cleanup (local only — no remote branch/PR operations)
# ============================================================
log "Pre-cycle cleanup (local only)..."

# Clean stale worktrees
git worktree prune 2>&1 | tee -a "${LOG_FILE}" || true
if [[ -d "${WORKTREE_BASE}" ]]; then
    rm -rf "${WORKTREE_BASE}" 2>&1 | tee -a "${LOG_FILE}" || true
    log "Removed stale ${WORKTREE_BASE} directory"
fi
mkdir -p "${WORKTREE_BASE}"

# Delete stale local qa-dry/* branches only
LOCAL_QA_BRANCHES=$(git branch --list 'qa-dry/*' | tr -d ' *') || true
for branch in $LOCAL_QA_BRANCHES; do
    if [[ -n "$branch" ]]; then
        git branch -D "$branch" 2>&1 | tee -a "${LOG_FILE}" || true
    fi
done

log "Pre-cycle cleanup complete"

# ============================================================
# Phase 0: Key Preflight
# ============================================================
log "=== Phase 0: Key Preflight ==="

if [[ -f "${REPO_ROOT}/shared/key-request.sh" ]]; then
    source "${REPO_ROOT}/shared/key-request.sh"
    load_cloud_keys_from_config
    if [[ -n "${MISSING_KEY_PROVIDERS:-}" ]]; then
        log "Key preflight: Missing keys for: ${MISSING_KEY_PROVIDERS}"
        log "Phase 0: Missing keys for: ${MISSING_KEY_PROVIDERS}"
        dry_log "request_missing_cloud_keys for: ${MISSING_KEY_PROVIDERS}"
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

RECORD_OUTPUT="/tmp/spawn-qa-dry-record-output.txt"
rm -f "${RECORD_OUTPUT}"

RECORD_EXIT=0
bash test/record.sh allsaved 2>&1 | tee -a "${LOG_FILE}" | tee "${RECORD_OUTPUT}" || RECORD_EXIT=$?

if [[ "${RECORD_EXIT}" -eq 0 ]]; then
    log "Phase 1: All fixtures recorded successfully"
else
    log "Phase 1: Some fixture recordings failed, identifying failed clouds..."

    # Parse which clouds had failures from record.sh output
    RECORD_FAILED_CLOUDS=""
    current_cloud=""
    while IFS= read -r line; do
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

            error_lines=$(sed -n "/Recording ${cloud}/,/Recording \|━━━ \|Results:/p" "${RECORD_OUTPUT}" | head -30 || true)

            log "Phase 1: Spawning agent to debug ${cloud} recording failure"
            worktree="${WORKTREE_BASE}/record-fix-${cloud}"
            branch_name="qa-dry/record-fix-${cloud}"

            git worktree add "${worktree}" -b "${branch_name}" HEAD 2>&1 | tee -a "${LOG_FILE}" || {
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
                has_commits=$(git log HEAD@{1}..HEAD --oneline 2>/dev/null || true)

                if [[ -n "$has_uncommitted" ]] && bash -n "${cloud}/lib/common.sh" 2>/dev/null; then
                    git add "${cloud}/lib/common.sh" "test/record.sh" 2>/dev/null || true
                    git commit -m "$(printf 'fix: Update %s API integration for recording\n\nAgent: qa-record-fixer (dry run)\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>' "${cloud}")" || true
                fi

                # Save diff instead of pushing
                git diff HEAD~1..HEAD > "${DRY_OUTPUT_DIR}/diff-record-fix-${cloud}.patch" 2>/dev/null || true
                dry_log "git push -u origin ${branch_name} && gh pr create for ${cloud} record fix"
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
            git branch -D "qa-dry/record-fix-${cloud}" 2>/dev/null || true
        done
        git worktree prune 2>/dev/null || true

        # Re-record (ONE retry, no agents on second failure) — no git reset to origin
        log "Phase 1: Re-recording after fixes (no agents on second failure)..."
        bash test/record.sh allsaved 2>&1 | tee -a "${LOG_FILE}" || {
            log "Phase 1: Re-record still has failures — continuing with existing fixtures"
        }
    fi

    # Log stale key request (but don't actually send)
    if [[ -n "${STALE_KEY_PROVIDERS:-}" ]]; then
        dry_log "request_missing_cloud_keys for stale providers: ${STALE_KEY_PROVIDERS}"
    fi
fi

# --- Track consecutive Phase 1 failures per cloud ---
FINAL_RECORD_FAILED=""
FINAL_RECORD_SUCCEEDED=""
if [[ -f "${RECORD_OUTPUT}" ]]; then
    _current_cloud=""
    _cloud_had_error=""
    while IFS= read -r line; do
        clean=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g')
        case "$clean" in
            *"Recording "*" ━━━"*)
                if [[ -n "${_current_cloud}" ]]; then
                    if [[ "${_cloud_had_error}" == "true" ]]; then
                        FINAL_RECORD_FAILED="${FINAL_RECORD_FAILED} ${_current_cloud}"
                    else
                        FINAL_RECORD_SUCCEEDED="${FINAL_RECORD_SUCCEEDED} ${_current_cloud}"
                    fi
                fi
                _current_cloud=$(printf '%s' "$clean" | sed 's/.*Recording //; s/ ━━━.*//')
                _cloud_had_error=""
                ;;
            *"fail "*)
                _cloud_had_error="true"
                ;;
            *"done "*)
                ;;
        esac
    done < "${RECORD_OUTPUT}"
    if [[ -n "${_current_cloud}" ]]; then
        if [[ "${_cloud_had_error}" == "true" ]]; then
            FINAL_RECORD_FAILED="${FINAL_RECORD_FAILED} ${_current_cloud}"
        else
            FINAL_RECORD_SUCCEEDED="${FINAL_RECORD_SUCCEEDED} ${_current_cloud}"
        fi
    fi
fi
FINAL_RECORD_FAILED=$(printf '%s' "${FINAL_RECORD_FAILED}" | sed 's/^ //')
FINAL_RECORD_SUCCEEDED=$(printf '%s' "${FINAL_RECORD_SUCCEEDED}" | sed 's/^ //')

# Log escalation info but don't create GitHub issues
if [[ -n "${FINAL_RECORD_FAILED}" ]]; then
    log "Phase 1: Failed clouds (would track/escalate): ${FINAL_RECORD_FAILED}"
    for cloud in ${FINAL_RECORD_FAILED}; do
        dry_log "gh issue create for ${cloud} persistent recording failure"
    done
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
    cp "${RESULTS_PHASE2}" "${DRY_OUTPUT_DIR}/results-phase2.txt" 2>/dev/null || true
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
    FAILURES=""
    FAILED_CLOUDS=""
    if [[ -f "${RESULTS_PHASE2}" ]]; then
        FAILURES=$(grep ':fail$' "${RESULTS_PHASE2}" | sed 's/:fail$//' || true)
        FAILED_CLOUDS=$(grep ':fail$' "${RESULTS_PHASE2}" | sed 's/:fail$//' | cut -d/ -f1 | sort -u || true)
    fi

    # Capture full mock test output per-cloud for richer agent context
    MOCK_OUTPUT_DIR="/tmp/spawn-qa-dry-mock-output"
    rm -rf "${MOCK_OUTPUT_DIR}"
    mkdir -p "${MOCK_OUTPUT_DIR}"
    for cloud in $FAILED_CLOUDS; do
        log "Phase 3: Capturing full mock test output for ${cloud}..."
        bash test/mock.sh "$cloud" > "${MOCK_OUTPUT_DIR}/${cloud}.log" 2>&1 || true
    done

    AGENT_PIDS=""
    for cloud in $FAILED_CLOUDS; do
        check_timeout || break

        cloud_failures=$(printf '%s\n' $FAILURES | grep "^${cloud}/" || true)
        failing_scripts=""
        failing_agents=""
        for combo in $cloud_failures; do
            agent=$(printf '%s' "$combo" | cut -d/ -f2)
            script_path="${cloud}/${agent}.sh"
            failing_scripts="${failing_scripts} ${script_path}"
            failing_agents="${failing_agents} ${agent}"
        done
        failing_scripts=$(printf '%s' "$failing_scripts" | sed 's/^ //')
        failing_agents=$(printf '%s' "$failing_agents" | sed 's/^ //')

        error_context=""
        if [[ -f "${MOCK_OUTPUT_DIR}/${cloud}.log" ]]; then
            error_context=$(cat "${MOCK_OUTPUT_DIR}/${cloud}.log")
            # Also save to output dir for inspection
            cp "${MOCK_OUTPUT_DIR}/${cloud}.log" "${DRY_OUTPUT_DIR}/agent-fix-${cloud}.log" 2>/dev/null || true
        fi

        fail_count=$(printf '%s\n' $cloud_failures | wc -l | tr -d ' ')
        log "Phase 3: Spawning agent to fix ${fail_count} failing script(s) in ${cloud}"

        worktree="${WORKTREE_BASE}/fix-${cloud}"
        branch_name="qa-dry/fix-${cloud}"

        git worktree add "${worktree}" -b "${branch_name}" HEAD 2>&1 | tee -a "${LOG_FILE}" || {
            log "Phase 3: Could not create worktree for ${cloud}, skipping"
            continue
        }

        dry_log "git worktree add ... -b qa/fix-${cloud} origin/main"

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

            # Always check for changes
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

Agent: qa-fixer (dry run)
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
FIXEOF
                )" || true
            fi

            # Save diff instead of pushing
            git diff HEAD~1..HEAD > "${DRY_OUTPUT_DIR}/diff-fix-${cloud}.patch" 2>/dev/null || true
            dry_log "git add ${cloud}/ test/fixtures/${cloud}/ test/mock.sh && git commit && git push && gh pr create for ${cloud}"
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
        git branch -D "qa-dry/fix-${cloud}" 2>/dev/null || true
    done
    git worktree prune 2>/dev/null || true

    # Clean up per-cloud mock output
    rm -rf "${MOCK_OUTPUT_DIR}" 2>/dev/null || true

    log "Phase 3: Fix agents complete"
fi

check_timeout || exit 0

# ============================================================
# Phase 4: Re-run mock tests + update README (local only)
# ============================================================
log "=== Phase 4: Re-run tests and update README ==="

# No git fetch/reset — work with current local state

rm -f "${RESULTS_PHASE4}"
RESULTS_FILE="${RESULTS_PHASE4}" bash test/mock.sh 2>&1 | tee -a "${LOG_FILE}" || true

if [[ -f "${RESULTS_PHASE4}" ]]; then
    RETRY_PASS=$(grep -c ':pass$' "${RESULTS_PHASE4}" || true)
    RETRY_FAIL=$(grep -c ':fail$' "${RESULTS_PHASE4}" || true)
    log "Phase 4: ${RETRY_PASS} passed, ${RETRY_FAIL} failed"
    cp "${RESULTS_PHASE4}" "${DRY_OUTPUT_DIR}/results-phase4.txt" 2>/dev/null || true

    python3 test/update-readme.py "${RESULTS_PHASE4}" 2>&1 | tee -a "${LOG_FILE}"

    # Save README diff instead of pushing
    if [[ -n "$(git diff --name-only README.md 2>/dev/null)" ]]; then
        git diff README.md > "${DRY_OUTPUT_DIR}/diff-readme.patch" 2>/dev/null || true
        log "Phase 4: README changes saved to ${DRY_OUTPUT_DIR}/diff-readme.patch"
        dry_log "git checkout -b qa/readme-update-\$(date +%s) && git add README.md && git commit && git push && gh pr create"
        # Revert the local README change so we don't leave dirty state
        git checkout README.md 2>/dev/null || true
    else
        log "Phase 4: No README changes needed"
    fi
else
    log "Phase 4: No results file generated"
fi

# Final summary
log "=== QA Dry Run Summary ==="
log "Phase 2: ${PASS_COUNT:-0} pass / ${FAIL_COUNT:-0} fail"
log "Phase 4: ${RETRY_PASS:-0} pass / ${RETRY_FAIL:-0} fail"
if [[ "${FAIL_COUNT:-0}" -gt 0 ]] && [[ "${RETRY_FAIL:-0}" -lt "${FAIL_COUNT:-0}" ]]; then
    FIXED=$(( ${FAIL_COUNT:-0} - ${RETRY_FAIL:-0} ))
    log "Fixed ${FIXED} failure(s) this cycle"
fi
log "Artifacts saved to: ${DRY_OUTPUT_DIR}/"
log "=== QA Dry Run Complete ==="
