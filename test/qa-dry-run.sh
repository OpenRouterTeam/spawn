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
# Phase 5: E2E Tests (optional — requires cloud credentials)
# ============================================================
E2E_PASS=0
E2E_FAIL=0
E2E_SKIPPED=0

if [[ -f "${REPO_ROOT}/test/e2e.sh" ]]; then
    # Check if any cloud credentials are available
    HAS_CLOUD_CREDS=0
    for _var in FLY_API_TOKEN HCLOUD_TOKEN DO_API_TOKEN DAYTONA_API_KEY OVH_APP_KEY; do
        if [[ -n "${!_var:-}" ]]; then
            HAS_CLOUD_CREDS=1
            break
        fi
    done

    if [[ "${HAS_CLOUD_CREDS}" -eq 1 ]] && [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
        log "=== Phase 5: E2E Tests ==="

        E2E_OUTPUT="${DRY_RUN_DIR}/e2e-output.txt"
        E2E_EXIT=0
        # Stream live so failures are visible immediately, not after the full run
        E2E_AUTO_FIX=0 bash "${REPO_ROOT}/test/e2e.sh" \
            2>&1 | tee "${E2E_OUTPUT}" | tee -a "${LOG_FILE}" || E2E_EXIT=$?

        # Count only cloud/agent lines (contain "/"), not pre-flight checkmarks
        if [[ -f "${E2E_OUTPUT}" ]]; then
            E2E_PASS=$(grep '✓' "${E2E_OUTPUT}" | grep -c '/' 2>/dev/null || true)
            E2E_FAIL=$(grep '✗' "${E2E_OUTPUT}" | grep -c '/' 2>/dev/null || true)
        fi

        if [[ "${E2E_EXIT}" -eq 0 ]]; then
            log "Phase 5: E2E tests passed (${E2E_PASS} passed)"
        else
            log "Phase 5: E2E tests had ${E2E_FAIL} failure(s), ${E2E_PASS} passed"
        fi

        # --- Phase 5b: Fix E2E failures (dry run — copies, no git/PR) ---
        if [[ "${E2E_FAIL}" -gt 0 ]] && [[ -f "${E2E_OUTPUT}" ]]; then
            check_timeout || true

            log "=== Phase 5b: Fix E2E failures ==="

            # Parse failing combos — only lines with "/" (skip pre-flight)
            E2E_FAILED_COMBOS=""
            E2E_FAILED_AGENTS=""
            while IFS= read -r line; do
                clean=$(printf '%s' "$line" | sed 's/\x1b\[[0-9;]*m//g')
                case "$clean" in
                    *"✗ "*"/"*)
                        combo=$(printf '%s' "$clean" | sed 's/.*✗ //; s/  .*//')
                        reason=$(printf '%s' "$clean" | sed 's/.*(\(.*\))/\1/' || true)
                        cloud="${combo%%/*}"
                        agent="${combo##*/}"
                        E2E_FAILED_COMBOS="${E2E_FAILED_COMBOS} ${cloud}/${agent}|${reason}"
                        case " ${E2E_FAILED_AGENTS} " in
                            *" ${agent} "*) ;;
                            *) E2E_FAILED_AGENTS="${E2E_FAILED_AGENTS} ${agent}" ;;
                        esac
                        ;;
                esac
            done < "${E2E_OUTPUT}"
            E2E_FAILED_COMBOS=$(printf '%s' "${E2E_FAILED_COMBOS}" | sed 's/^ //')
            E2E_FAILED_AGENTS=$(printf '%s' "${E2E_FAILED_AGENTS}" | sed 's/^ //')

            if [[ -n "${E2E_FAILED_AGENTS}" ]]; then
                log "Phase 5b: Failing agents: ${E2E_FAILED_AGENTS}"

                E2E_FIX_PIDS=""
                E2E_FIX_WORK_DIRS=""

                for agent in ${E2E_FAILED_AGENTS}; do
                    check_timeout || break

                    # Collect failing clouds and reasons
                    failing_clouds=""
                    failure_summary=""
                    for entry in ${E2E_FAILED_COMBOS}; do
                        entry_combo="${entry%%|*}"
                        entry_reason="${entry#*|}"
                        entry_agent="${entry_combo##*/}"
                        entry_cloud="${entry_combo%%/*}"
                        if [[ "${entry_agent}" == "${agent}" ]]; then
                            failing_clouds="${failing_clouds} ${entry_cloud}"
                            failure_summary="${failure_summary}  - ${entry_cloud}/${agent}.sh: ${entry_reason}\n"
                        fi
                    done
                    failing_clouds=$(printf '%s' "${failing_clouds}" | sed 's/^ //')

                    # Find ALL clouds with this agent
                    all_clouds_for_agent=""
                    other_cloud_scripts=""
                    for cloud_dir in "${REPO_ROOT}"/*/; do
                        cname=$(basename "${cloud_dir}")
                        [[ "${cname}" == "shared" || "${cname}" == "cli" || "${cname}" == "test" || "${cname}" == ".claude" || "${cname}" == ".github" || "${cname}" == ".docs" ]] && continue
                        if [[ -f "${cloud_dir}${agent}.sh" ]]; then
                            all_clouds_for_agent="${all_clouds_for_agent} ${cname}"
                            case " ${failing_clouds} " in
                                *" ${cname} "*) ;;
                                *) other_cloud_scripts="${other_cloud_scripts} ${cname}/${agent}.sh" ;;
                            esac
                        fi
                    done
                    all_clouds_for_agent=$(printf '%s' "${all_clouds_for_agent}" | sed 's/^ //')
                    other_cloud_scripts=$(printf '%s' "${other_cloud_scripts}" | sed 's/^ //')

                    fail_count=0
                    for _c in ${failing_clouds}; do fail_count=$((fail_count + 1)); done

                    log "Phase 5b: Spawning agent for '${agent}' (${fail_count} failure(s), propagating to: ${other_cloud_scripts:-none})"
                    would_commit "git worktree add ... -b qa/e2e-fix-${agent} origin/main"

                    WORK_DIR=$(mktemp -d "/tmp/spawn-qa-dry-XXXXXX")
                    cp -r "${REPO_ROOT}/." "${WORK_DIR}/" 2>/dev/null || true
                    ORIG_HEAD=$(cd "${WORK_DIR}" && git rev-parse HEAD 2>/dev/null) || ORIG_HEAD=""

                    modify_files=""
                    for _c in ${all_clouds_for_agent}; do
                        modify_files="${modify_files} ${_c}/${agent}.sh ${_c}/lib/common.sh"
                    done

                    (
                        cd "${WORK_DIR}"
                        run_with_timeout "${AGENT_TIMEOUT}" claude -p "Fix E2E test failures for agent **${agent}** and propagate fixes to all clouds.

## E2E Failure Summary
$(printf '%b' "${failure_summary}")
## All clouds with ${agent}
${all_clouds_for_agent}

## What happened
These scripts were run with real cloud servers (SPAWN_NON_INTERACTIVE=1, no TTY).
A script passes if it prints 'setup completed successfully' before the session step.
Common E2E failure causes:
- Install command fails (wrong package name, missing repo, network timeout)
- Config file written to wrong path or with wrong permissions
- Env var injection missing (OPENROUTER_API_KEY, ANTHROPIC_BASE_URL, etc.)
- Script hangs on an interactive prompt that wasn't guarded by SPAWN_NON_INTERACTIVE
- SSH wait/connect fails (firewall, wrong port, key not imported)

## Fix Process

1. **Read each failing script** and its cloud's lib/common.sh.
2. **Compare with working clouds.** Diff the scripts — look for divergence.
3. **Fix the root cause** in each failing script.
4. **Propagate to other clouds:** ${other_cloud_scripts:-"(no other clouds)"}
   Only propagate if the same problematic pattern exists.
5. **Validate:** Run bash -n on every modified .sh file.

You may modify:${modify_files}" \
                            2>&1 | tee -a "${DRY_RUN_DIR}/agent-e2e-fix-${agent}.log" || true

                        # Copy changed files back to repo
                        changed=$(git diff --name-only "${ORIG_HEAD}" 2>/dev/null || true)
                        uncommitted=$(git status --porcelain 2>/dev/null | sed 's/^.. //' || true)
                        for f in ${changed} ${uncommitted}; do
                            [[ -f "$f" ]] || continue
                            mkdir -p "${REPO_ROOT}/$(dirname "$f")"
                            cp "$f" "${REPO_ROOT}/$f"
                        done
                    ) &
                    E2E_FIX_PIDS="${E2E_FIX_PIDS} $!"
                    E2E_FIX_WORK_DIRS="${E2E_FIX_WORK_DIRS} ${WORK_DIR}"
                done

                # Wait for all E2E fix agents
                for pid in ${E2E_FIX_PIDS}; do
                    wait "$pid" 2>/dev/null || true
                done

                for agent in ${E2E_FAILED_AGENTS}; do
                    would_commit "git add */\${agent}.sh && git commit && git push && gh pr create && gh pr merge"
                done
                for work_dir in ${E2E_FIX_WORK_DIRS}; do
                    rm -rf "${work_dir}"
                done

                log "Phase 5b: E2E fix agents complete"
            fi
        fi
    else
        E2E_SKIPPED=1
        log "=== Phase 5: E2E Tests (Skipped — no cloud credentials or OPENROUTER_API_KEY) ==="
    fi
else
    E2E_SKIPPED=1
    log "=== Phase 5: E2E Tests (Skipped — test/e2e.sh not found) ==="
fi

check_timeout || exit 0

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
if [[ "${E2E_SKIPPED:-0}" -eq 0 ]]; then
    log "Phase 5 (e2e):       ${E2E_PASS:-0} pass / ${E2E_FAIL:-0} fail"
else
    log "Phase 5 (e2e):       skipped"
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
