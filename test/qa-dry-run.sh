#!/bin/bash
set -eo pipefail

# QA Dry Run — Local-only version of qa-cycle.sh
# Does everything qa-cycle.sh does but with NO git/gh commands.
# All output goes to .docs/qa-dry-run-latest/.
#
# Usage:
#   bash test/qa-dry-run.sh

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "${REPO_ROOT}" ]]; then
    REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "${REPO_ROOT}"

DRY_RUN_DIR="${REPO_ROOT}/.docs/qa-dry-run-latest"
LOG_FILE="${DRY_RUN_DIR}/qa-dry-run.log"
WOULD_COMMIT_LOG="${DRY_RUN_DIR}/would-commit.txt"
CYCLE_TIMEOUT=2700  # 45 min total
AGENT_TIMEOUT=600   # 10 min per agent

# Results files
RESULTS_PHASE2="${DRY_RUN_DIR}/results-phase2.txt"
RESULTS_PHASE4="${DRY_RUN_DIR}/results-phase4.txt"

# Clean and create output directory
rm -rf "${DRY_RUN_DIR}"
mkdir -p "${DRY_RUN_DIR}"
: > "${LOG_FILE}"
: > "${WOULD_COMMIT_LOG}"

log() {
    printf '[%s] [qa-dry] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*" | tee -a "${LOG_FILE}"
}

cleanup() {
    local exit_code=$?
    log "=== QA Dry Run Done (exit_code=${exit_code}) ==="
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
log "Output dir: ${DRY_RUN_DIR}"
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

would_commit() {
    printf '[would-run] %s\n' "$*" >> "${WOULD_COMMIT_LOG}"
}

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
# Phase 0.5: macOS Compatibility Lint
# ============================================================
log "=== Phase 0.5: macOS Compatibility Lint ==="

LINT_OUTPUT="${DRY_RUN_DIR}/macos-compat-output.txt"
LINT_ERRORS=0
LINT_WARNS=0

if [[ -f "${REPO_ROOT}/test/macos-compat.sh" ]]; then
    LINT_EXIT=0
    bash "${REPO_ROOT}/test/macos-compat.sh" > "${LINT_OUTPUT}" 2>&1 || LINT_EXIT=$?

    if [[ -f "${LINT_OUTPUT}" ]]; then
        LINT_ERRORS=$(grep -c "^error " "${LINT_OUTPUT}" 2>/dev/null || true)
        LINT_WARNS=$(grep -c "^warn " "${LINT_OUTPUT}" 2>/dev/null || true)
    fi

    if [[ "${LINT_EXIT}" -eq 0 ]]; then
        log "Phase 0.5: macOS compat lint passed (${LINT_WARNS} warning(s))"
    else
        log "Phase 0.5: macOS compat lint found ${LINT_ERRORS} error(s), ${LINT_WARNS} warning(s)"
        log "Phase 0.5: Continuing (lint is advisory for now)"
    fi
else
    log "Phase 0.5: test/macos-compat.sh not found, skipping"
fi

check_timeout || exit 0

# ============================================================
# Phase 1: Record fixtures
# ============================================================
log "=== Phase 1: Record fixtures ==="

RECORD_OUTPUT="${DRY_RUN_DIR}/record-output.txt"

RECORD_EXIT=0
bash test/record.sh allsaved 2>&1 | tee -a "${LOG_FILE}" | tee "${RECORD_OUTPUT}" || RECORD_EXIT=$?

if [[ "${RECORD_EXIT}" -eq 0 ]]; then
    log "Phase 1: All fixtures recorded successfully"
else
    log "Phase 1: Some fixture recordings failed, identifying failed clouds..."

    # Parse which clouds had failures
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
                        *" ${current_cloud} "*) ;;
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
                log "Phase 1: Auth failure for ${cloud} — key is stale"
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

        # Spawn all record-fix agents in parallel (one per non-auth failed cloud)
        RECORD_FIX_PIDS=""
        RECORD_FIX_WORK_DIRS=""

        for cloud in ${NON_AUTH_FAILED_CLOUDS}; do
            check_timeout || break

            error_lines=$(sed -n "/Recording ${cloud}/,/Recording \|━━━ \|Results:/p" "${RECORD_OUTPUT}" | head -30 || true)

            log "Phase 1: Spawning agent to debug ${cloud} recording failure (async)"
            would_commit "git worktree add ... -b qa/record-fix-${cloud} origin/main"

            WORK_DIR=$(mktemp -d "/tmp/spawn-qa-dry-XXXXXX")
            cp -r "${REPO_ROOT}/." "${WORK_DIR}/" 2>/dev/null || true

            ORIG_HEAD=$(cd "${WORK_DIR}" && git rev-parse HEAD 2>/dev/null) || ORIG_HEAD=""

            (
                cd "${WORK_DIR}"
                run_with_timeout "${AGENT_TIMEOUT}" claude -p "The API fixture recording for cloud '${cloud}' is failing in test/record.sh.

Error output:
${error_lines}

Investigate and fix. Only modify ${cloud}/lib/common.sh and test/record.sh." \
                    2>&1 | tee -a "${DRY_RUN_DIR}/agent-record-fix-${cloud}.log" || true

                # Copy changed files directly back to repo
                changed=$(git diff --name-only "${ORIG_HEAD}" 2>/dev/null || true)
                if [[ -n "$changed" ]]; then
                    printf '%s\n' "$changed" | while IFS= read -r f; do
                        [[ -f "$f" ]] || continue
                        mkdir -p "${REPO_ROOT}/$(dirname "$f")"
                        cp "$f" "${REPO_ROOT}/$f"
                    done
                fi
            ) &
            RECORD_FIX_PIDS="${RECORD_FIX_PIDS} $!"
            RECORD_FIX_WORK_DIRS="${RECORD_FIX_WORK_DIRS} ${WORK_DIR}"
        done

        # Wait for all record-fix agents
        if [[ -n "${RECORD_FIX_PIDS}" ]]; then
            log "Phase 1: Waiting for record-fix agents..."
            for pid in ${RECORD_FIX_PIDS}; do
                wait "$pid" 2>/dev/null || true
            done
        fi

        # Log what changed and clean up work dirs
        for cloud in ${NON_AUTH_FAILED_CLOUDS}; do
            would_commit "git add ${cloud}/lib/common.sh test/record.sh && git commit && git push && gh pr create && gh pr merge"
        done
        for work_dir in ${RECORD_FIX_WORK_DIRS}; do
            rm -rf "${work_dir}"
        done

        # Re-record after fixes
        log "Phase 1: Re-recording after fixes..."
        bash test/record.sh allsaved 2>&1 | tee -a "${LOG_FILE}" || {
            log "Phase 1: Re-record still has failures — continuing with existing fixtures"
        }
    fi

    # Request fresh keys for stale providers (triggers email via key-server)
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

PASS_COUNT=0
FAIL_COUNT=0
if [[ -f "${RESULTS_PHASE2}" ]]; then
    TOTAL_TESTS=$(wc -l < "${RESULTS_PHASE2}" | tr -d ' ')
    PASS_COUNT=$(grep -c ':pass$' "${RESULTS_PHASE2}" || true)
    FAIL_COUNT=$(grep -c ':fail$' "${RESULTS_PHASE2}" || true)
    log "Phase 2: ${PASS_COUNT} passed, ${FAIL_COUNT} failed, ${TOTAL_TESTS} total"
else
    log "Phase 2: No results file generated"
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

    # Spawn all fix agents in parallel (one per failed cloud)
    FIX_PIDS=""
    FIX_WORK_DIRS=""
    FIX_ORIG_HEADS=""

    for cloud in $FAILED_CLOUDS; do
        check_timeout || break

        cloud_failures=$(printf '%s\n' $FAILURES | grep "^${cloud}/" || true)
        failing_scripts=""
        error_context=""
        for combo in $cloud_failures; do
            agent=$(printf '%s' "$combo" | cut -d/ -f2)
            script_path="${cloud}/${agent}.sh"
            failing_scripts="${failing_scripts} ${script_path}"
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

        fail_count=$(printf '%s\n' $cloud_failures | wc -l | tr -d ' ')
        log "Phase 3: Spawning agent to fix ${fail_count} failing script(s) in ${cloud} (async)"
        would_commit "git worktree add ... -b qa/fix-${cloud} origin/main"

        WORK_DIR=$(mktemp -d "/tmp/spawn-qa-dry-XXXXXX")
        cp -r "${REPO_ROOT}/." "${WORK_DIR}/" 2>/dev/null || true

        ORIG_HEAD=$(cd "${WORK_DIR}" && git rev-parse HEAD 2>/dev/null) || ORIG_HEAD=""

        # Run agent in background subshell — log to per-cloud file to avoid interleaving
        (
            cd "${WORK_DIR}"
            run_with_timeout 900 claude -p "Fix the failing mock tests for cloud '${cloud}' in the spawn codebase.

Failing scripts: ${failing_scripts}

Error context from test run:
${error_context}

Investigate the root cause and fix. You can modify: scripts in ${cloud}/, test/fixtures/${cloud}/, and test/mock.sh." \
                2>&1 | tee -a "${DRY_RUN_DIR}/agent-fix-${cloud}.log" || true

            # Copy changed files directly back to repo
            changed=$(git diff --name-only "${ORIG_HEAD}" 2>/dev/null || true)
            if [[ -n "$changed" ]]; then
                printf '%s\n' "$changed" | while IFS= read -r f; do
                    [[ -f "$f" ]] || continue
                    mkdir -p "${REPO_ROOT}/$(dirname "$f")"
                    cp "$f" "${REPO_ROOT}/$f"
                done
            fi
        ) &
        FIX_PIDS="${FIX_PIDS} $!"
        FIX_WORK_DIRS="${FIX_WORK_DIRS} ${WORK_DIR}"
    done

    # Wait for all agents to finish
    if [[ -n "${FIX_PIDS}" ]]; then
        log "Phase 3: Waiting for ${FAILED_CLOUDS} fix agents..."
        for pid in ${FIX_PIDS}; do
            wait "$pid" 2>/dev/null || true
        done
    fi

    # Log and clean up work dirs
    for cloud in $FAILED_CLOUDS; do
        would_commit "git add ${cloud}/ test/fixtures/${cloud}/ test/mock.sh && git commit && git push && gh pr create && gh pr merge"
    done
    for work_dir in ${FIX_WORK_DIRS}; do
        rm -rf "${work_dir}"
    done

    log "Phase 3: Fix agents complete"
fi

check_timeout || exit 0

# ============================================================
# Phase 4: Re-run mock tests + update README (no commit)
# ============================================================
log "=== Phase 4: Re-run tests and update README ==="

rm -f "${RESULTS_PHASE4}"
RESULTS_FILE="${RESULTS_PHASE4}" bash test/mock.sh 2>&1 | tee -a "${LOG_FILE}" || true

RETRY_PASS=0
RETRY_FAIL=0
if [[ -f "${RESULTS_PHASE4}" ]]; then
    RETRY_PASS=$(grep -c ':pass$' "${RESULTS_PHASE4}" || true)
    RETRY_FAIL=$(grep -c ':fail$' "${RESULTS_PHASE4}" || true)
    log "Phase 4: ${RETRY_PASS} passed, ${RETRY_FAIL} failed"

    if [[ -f "test/update-readme.py" ]]; then
        python3 test/update-readme.py "${RESULTS_PHASE4}" 2>&1 | tee -a "${LOG_FILE}" || true

        if [[ -n "$(git diff --name-only README.md 2>/dev/null)" ]]; then
            would_commit "git checkout -b qa/readme-update-\$(date +%s) && git add README.md && git commit && git push && gh pr create && gh pr merge"
            # Show the diff but don't commit
            git diff README.md > "${DRY_RUN_DIR}/diff-readme.patch" 2>/dev/null || true
            # Revert README changes (dry run) - use git restore to avoid checkout pollution
            git restore README.md 2>/dev/null || git checkout -- README.md 2>/dev/null || true
            log "Phase 4: README diff saved to diff-readme.patch (not committed)"
        else
            log "Phase 4: No README changes needed"
        fi
    fi
else
    log "Phase 4: No results file generated"
fi

# ============================================================
# Summary
# ============================================================
log ""
log "=== QA Dry Run Summary ==="
log "Phase 0.5 (lint):    ${LINT_ERRORS:-0} error(s) / ${LINT_WARNS:-0} warning(s)"
log "Phase 2 (initial):   ${PASS_COUNT:-0} pass / ${FAIL_COUNT:-0} fail"
log "Phase 4 (after fix): ${RETRY_PASS:-0} pass / ${RETRY_FAIL:-0} fail"
if [[ "${FAIL_COUNT:-0}" -gt 0 ]] && [[ "${RETRY_FAIL:-0}" -lt "${FAIL_COUNT:-0}" ]]; then
    FIXED=$(( ${FAIL_COUNT:-0} - ${RETRY_FAIL:-0} ))
    log "Fixed ${FIXED} failure(s) this cycle"
fi
log ""
log "Output files:"
log "  ${DRY_RUN_DIR}/qa-dry-run.log          — full log"
log "  ${DRY_RUN_DIR}/macos-compat-output.txt  — macOS compat lint output"
log "  ${DRY_RUN_DIR}/results-phase2.txt       — mock test results (initial)"
log "  ${DRY_RUN_DIR}/results-phase4.txt       — mock test results (after fixes)"
log "  ${DRY_RUN_DIR}/would-commit.txt         — git/gh commands that would have run"

# List patch files
PATCH_COUNT=0
for pf in "${DRY_RUN_DIR}"/diff-*.patch; do
    [[ -f "$pf" ]] || continue
    if [[ -s "$pf" ]]; then
        log "  $(basename "$pf")  — $(wc -l < "$pf" | tr -d ' ') lines"
        PATCH_COUNT=$((PATCH_COUNT + 1))
    fi
done
if [[ "$PATCH_COUNT" -eq 0 ]]; then
    log "  (no patches generated)"
fi

log ""
log "=== QA Dry Run Complete ==="
