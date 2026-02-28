#!/bin/bash
# sh/e2e/e2e.sh — Unified multi-cloud E2E test orchestrator
#
# Usage:
#   e2e.sh --cloud aws                          # AWS only, all agents
#   e2e.sh --cloud hetzner claude codex         # Hetzner, specific agents
#   e2e.sh --cloud aws --cloud hetzner          # Both clouds IN PARALLEL
#   e2e.sh --cloud all                          # ALL clouds IN PARALLEL
#   e2e.sh --cloud all --parallel 3             # All clouds, 3 agents parallel per cloud
#   e2e.sh --cloud aws --skip-input-test        # Skip live input tests
#   e2e.sh --cloud aws --sequential             # Force sequential agents (no parallelism)
set -eo pipefail

# ---------------------------------------------------------------------------
# Resolve script directory and source libraries
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Auto-set SPAWN_CLI_DIR to repo root so shell scripts use local source instead
# of downloading pre-bundled .js from GitHub releases. Can be overridden by env.
if [ -z "${SPAWN_CLI_DIR:-}" ]; then
  _repo_root="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  if [ -f "${_repo_root}/packages/cli/src/index.ts" ]; then
    export SPAWN_CLI_DIR="${_repo_root}"
  fi
  unset _repo_root
fi

source "${SCRIPT_DIR}/lib/common.sh"
source "${SCRIPT_DIR}/lib/provision.sh"
source "${SCRIPT_DIR}/lib/verify.sh"
source "${SCRIPT_DIR}/lib/teardown.sh"
source "${SCRIPT_DIR}/lib/cleanup.sh"

# ---------------------------------------------------------------------------
# All supported clouds (excluding local — no infra to provision)
# ---------------------------------------------------------------------------
ALL_CLOUDS="aws hetzner digitalocean gcp daytona sprite"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
CLOUDS=""
AGENTS_TO_TEST=""
PARALLEL_COUNT=99
SKIP_CLEANUP=0
SKIP_INPUT_TEST="${SKIP_INPUT_TEST:-0}"
SEQUENTIAL_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cloud)
      shift
      if [ $# -eq 0 ]; then
        printf "Error: --cloud requires a cloud name\n" >&2
        exit 1
      fi
      if [ "$1" = "all" ]; then
        CLOUDS="${ALL_CLOUDS}"
      else
        # Validate cloud name
        local_valid=0
        for c in ${ALL_CLOUDS}; do
          if [ "$1" = "${c}" ]; then
            local_valid=1
            break
          fi
        done
        if [ "${local_valid}" -eq 0 ]; then
          printf "Unknown cloud: %s\nAvailable: %s all\n" "$1" "${ALL_CLOUDS}" >&2
          exit 1
        fi
        if [ -z "${CLOUDS}" ]; then
          CLOUDS="$1"
        else
          CLOUDS="${CLOUDS} $1"
        fi
      fi
      shift
      ;;
    --parallel)
      shift
      if [ $# -eq 0 ]; then
        printf "Error: --parallel requires a number\n" >&2
        exit 1
      fi
      PARALLEL_COUNT="$1"
      shift
      ;;
    --sequential)
      SEQUENTIAL_MODE=1
      shift
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=1
      shift
      ;;
    --skip-input-test)
      SKIP_INPUT_TEST=1
      shift
      ;;
    --help|-h)
      printf "Usage: %s --cloud CLOUD [--cloud CLOUD2 ...] [agents...] [options]\n\n" "$0"
      printf "Clouds: %s\n" "${ALL_CLOUDS}"
      printf "         Use --cloud all for all clouds in parallel.\n\n"
      printf "Agents: %s\n\n" "${ALL_AGENTS}"
      printf "Options:\n"
      printf "  --cloud CLOUD       Cloud to test (repeatable, or 'all')\n"
      printf "  --parallel N        Run N agents in parallel per cloud (default: all at once)\n"
      printf "  --sequential        Force sequential agent execution\n"
      printf "  --skip-cleanup      Skip stale e2e-* instance cleanup\n"
      printf "  --skip-input-test   Skip live input tests\n"
      printf "  --help              Show this help\n"
      exit 0
      ;;
    -*)
      printf "Unknown option: %s\n" "$1" >&2
      exit 1
      ;;
    *)
      # Agent name
      local_valid=0
      for a in ${ALL_AGENTS}; do
        if [ "$1" = "${a}" ]; then
          local_valid=1
          break
        fi
      done
      if [ "${local_valid}" -eq 0 ]; then
        printf "Unknown agent: %s\nAvailable: %s\n" "$1" "${ALL_AGENTS}" >&2
        exit 1
      fi
      if [ -z "${AGENTS_TO_TEST}" ]; then
        AGENTS_TO_TEST="$1"
      else
        AGENTS_TO_TEST="${AGENTS_TO_TEST} $1"
      fi
      shift
      ;;
  esac
done

# Require at least one cloud
if [ -z "${CLOUDS}" ]; then
  printf "Error: --cloud is required. Use --cloud aws, --cloud all, etc.\n" >&2
  printf "Run %s --help for usage.\n" "$0" >&2
  exit 1
fi

# Default to all agents
if [ -z "${AGENTS_TO_TEST}" ]; then
  AGENTS_TO_TEST="${ALL_AGENTS}"
fi

# ---------------------------------------------------------------------------
# Count clouds to decide single vs multi-cloud mode
# ---------------------------------------------------------------------------
cloud_count=0
for _ in ${CLOUDS}; do cloud_count=$((cloud_count + 1)); done

# ---------------------------------------------------------------------------
# run_single_agent AGENT
#
# Provisions, verifies, and tears down a single agent.
# Sets result in a temp file for parallel collection.
# ---------------------------------------------------------------------------
run_single_agent() {
  local agent="$1"
  local result_file="${2:-}"
  local agent_start
  agent_start=$(date +%s)

  log_header "Testing agent: ${agent}"

  local app_name
  app_name=$(make_app_name "${agent}")
  track_app "${app_name}"

  local status="fail"

  # Provision -> Verify -> Input Test
  if provision_agent "${agent}" "${app_name}" "${LOG_DIR}"; then
    if verify_agent "${agent}" "${app_name}"; then
      if run_input_test "${agent}" "${app_name}"; then
        status="pass"
      fi
    fi
  fi

  # Teardown (always attempt)
  teardown_agent "${app_name}" || log_warn "Teardown failed for ${app_name}"

  local agent_end
  agent_end=$(date +%s)
  local agent_duration=$((agent_end - agent_start))
  local duration_str
  duration_str=$(format_duration "${agent_duration}")

  if [ "${status}" = "pass" ]; then
    log_ok "${agent} PASSED (${duration_str})"
  else
    log_err "${agent} FAILED (${duration_str})"
  fi

  # Write result to file (for parallel collection)
  if [ -n "${result_file}" ]; then
    printf '%s' "${status}" > "${result_file}"
  fi

  return 0
}

# ---------------------------------------------------------------------------
# run_agents_for_cloud CLOUD LOG_DIR
#
# Runs all agents for a single cloud. Supports parallel batching.
# Writes per-agent results to LOG_DIR/{cloud}-{agent}.result.
# Writes cloud summary to LOG_DIR/{cloud}.summary.
# ---------------------------------------------------------------------------
run_agents_for_cloud() {
  local cloud="$1"
  local log_dir="$2"
  local cloud_start
  cloud_start=$(date +%s)

  # Load the cloud driver
  load_cloud_driver "${cloud}"

  # Set log prefix for multi-cloud output
  if [ "${cloud_count}" -gt 1 ]; then
    CLOUD_LOG_PREFIX="[${cloud}] "
  fi

  log_header "E2E Tests: ${cloud}"
  log_info "Agents: ${AGENTS_TO_TEST}"

  # Validate environment for this cloud
  if ! require_env; then
    log_err "Environment validation failed for ${cloud}"
    # Write fail results for all agents
    for agent in ${AGENTS_TO_TEST}; do
      printf 'fail' > "${log_dir}/${cloud}-${agent}.result"
    done
    printf 'FAILED (env validation)' > "${log_dir}/${cloud}.summary"
    return 1
  fi

  local cloud_passed=""
  local cloud_failed=""

  # Resolve effective parallelism (respect per-cloud cap)
  local effective_parallel="${PARALLEL_COUNT}"
  if [ "${SEQUENTIAL_MODE}" -eq 0 ]; then
    local cloud_max
    cloud_max=$(cloud_max_parallel)
    if [ "${effective_parallel}" -gt "${cloud_max}" ]; then
      effective_parallel="${cloud_max}"
    fi
  fi

  if [ "${effective_parallel}" -gt 0 ] && [ "${SEQUENTIAL_MODE}" -eq 0 ]; then
    # Parallel mode: batch agents
    log_info "Running agents in parallel (batch size: ${effective_parallel})"

    local batch_agents=""
    local batch_count=0
    local batch_num=0

    for agent in ${AGENTS_TO_TEST}; do
      batch_agents="${batch_agents} ${agent}"
      batch_count=$((batch_count + 1))

      if [ "${batch_count}" -ge "${effective_parallel}" ]; then
        batch_num=$((batch_num + 1))
        log_header "Batch ${batch_num} (${cloud})"

        pids=""
        for ba in ${batch_agents}; do
          local_result_file="${log_dir}/${cloud}-${ba}.result"
          run_single_agent "${ba}" "${local_result_file}" &
          if [ -z "${pids}" ]; then pids="$!"; else pids="${pids} $!"; fi
        done

        for p in ${pids}; do
          wait "${p}" 2>/dev/null || true
        done

        # Collect batch results
        for ba in ${batch_agents}; do
          local_result_file="${log_dir}/${cloud}-${ba}.result"
          if [ -f "${local_result_file}" ] && [ "$(cat "${local_result_file}")" = "pass" ]; then
            if [ -z "${cloud_passed}" ]; then cloud_passed="${ba}"; else cloud_passed="${cloud_passed} ${ba}"; fi
          else
            if [ -z "${cloud_failed}" ]; then cloud_failed="${ba}"; else cloud_failed="${cloud_failed} ${ba}"; fi
          fi
        done

        batch_agents=""
        batch_count=0
      fi
    done

    # Handle remaining agents in last partial batch
    if [ -n "${batch_agents}" ]; then
      batch_num=$((batch_num + 1))
      log_header "Batch ${batch_num} (${cloud})"

      pids=""
      for ba in ${batch_agents}; do
        local_result_file="${log_dir}/${cloud}-${ba}.result"
        run_single_agent "${ba}" "${local_result_file}" &
        if [ -z "${pids}" ]; then pids="$!"; else pids="${pids} $!"; fi
      done

      for p in ${pids}; do
        wait "${p}" 2>/dev/null || true
      done

      for ba in ${batch_agents}; do
        local_result_file="${log_dir}/${cloud}-${ba}.result"
        if [ -f "${local_result_file}" ] && [ "$(cat "${local_result_file}")" = "pass" ]; then
          if [ -z "${cloud_passed}" ]; then cloud_passed="${ba}"; else cloud_passed="${cloud_passed} ${ba}"; fi
        else
          if [ -z "${cloud_failed}" ]; then cloud_failed="${ba}"; else cloud_failed="${cloud_failed} ${ba}"; fi
        fi
      done
    fi

  else
    # Sequential mode
    for agent in ${AGENTS_TO_TEST}; do
      local_result_file="${log_dir}/${cloud}-${agent}.result"
      run_single_agent "${agent}" "${local_result_file}"

      if [ -f "${local_result_file}" ] && [ "$(cat "${local_result_file}")" = "pass" ]; then
        if [ -z "${cloud_passed}" ]; then cloud_passed="${agent}"; else cloud_passed="${cloud_passed} ${agent}"; fi
      else
        if [ -z "${cloud_failed}" ]; then cloud_failed="${agent}"; else cloud_failed="${cloud_failed} ${agent}"; fi
      fi
    done
  fi

  # Stale cleanup
  if [ "${SKIP_CLEANUP}" -eq 0 ]; then
    cloud_cleanup_stale || log_warn "Stale cleanup encountered errors"
  fi

  # Write cloud summary
  local cloud_end
  cloud_end=$(date +%s)
  local cloud_duration=$((cloud_end - cloud_start))
  local cloud_duration_str
  cloud_duration_str=$(format_duration "${cloud_duration}")

  local pass_count=0
  local fail_count=0
  for _ in ${cloud_passed}; do pass_count=$((pass_count + 1)); done
  for _ in ${cloud_failed}; do fail_count=$((fail_count + 1)); done

  printf '%s %s %s %s %s' "${pass_count}" "${fail_count}" "${cloud_duration_str}" "${cloud_passed}" "|${cloud_failed}" \
    > "${log_dir}/${cloud}.summary"

  if [ "${fail_count}" -gt 0 ]; then
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Final cleanup trap
# ---------------------------------------------------------------------------
final_cleanup() {
  if [ -n "${_TRACKED_APPS}" ]; then
    printf "\n"
    log_warn "Cleaning up tracked instances on exit..."
    for app in ${_TRACKED_APPS}; do
      log_step "Tearing down ${app}..."
      teardown_agent "${app}" 2>/dev/null || log_warn "Failed to tear down ${app}"
    done
  fi
  if [ -n "${LOG_DIR:-}" ] && [ -d "${LOG_DIR:-}" ]; then
    rm -rf "${LOG_DIR}"
  fi
}
trap final_cleanup EXIT

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log_header "Spawn E2E Test Suite (Multi-Cloud)"
log_info "Clouds: ${CLOUDS}"
log_info "Agents: ${AGENTS_TO_TEST}"
if [ "${SEQUENTIAL_MODE}" -eq 1 ]; then
  log_info "Agent parallelism: sequential"
elif [ "${PARALLEL_COUNT}" -ge 99 ]; then
  log_info "Agent parallelism: all at once (per-cloud caps may apply)"
else
  log_info "Agent parallelism: ${PARALLEL_COUNT} per cloud"
fi
if [ "${SKIP_INPUT_TEST}" -eq 1 ]; then
  log_info "Input tests: SKIPPED"
fi

# Create temp log directory
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spawn-e2e.XXXXXX")
export LOG_DIR
log_info "Log directory: ${LOG_DIR}"

START_TIME=$(date +%s)

# ---------------------------------------------------------------------------
# Execute: single-cloud or multi-cloud
# ---------------------------------------------------------------------------
if [ "${cloud_count}" -eq 1 ]; then
  # Single cloud — run directly in this process
  run_agents_for_cloud "${CLOUDS}" "${LOG_DIR}" || true

else
  # Multi-cloud — each cloud runs as a separate background process
  cloud_pids=""
  for cloud in ${CLOUDS}; do
    (
      # Reset parent's EXIT trap — the main process handles LOG_DIR cleanup
      trap - EXIT
      _TRACKED_APPS=""
      run_agents_for_cloud "${cloud}" "${LOG_DIR}"
    ) > "${LOG_DIR}/${cloud}.log" 2>&1 &
    cloud_pid=$!
    if [ -z "${cloud_pids}" ]; then
      cloud_pids="${cloud_pid}"
    else
      cloud_pids="${cloud_pids} ${cloud_pid}"
    fi
    log_info "Started ${cloud} tests (PID: ${cloud_pid})"
  done

  # Wait for all clouds to finish
  any_failed=0
  for pid in ${cloud_pids}; do
    wait "${pid}" 2>/dev/null || any_failed=1
  done

  # Print per-cloud logs
  for cloud in ${CLOUDS}; do
    if [ -f "${LOG_DIR}/${cloud}.log" ]; then
      printf "\n"
      log_header "Output: ${cloud}"
      cat "${LOG_DIR}/${cloud}.log"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Unified Summary
# ---------------------------------------------------------------------------
END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))
DURATION_STR=$(format_duration "${TOTAL_DURATION}")

printf "\n"
log_header "E2E Test Summary"

total_pass=0
total_fail=0
any_cloud_failed=0

for cloud in ${CLOUDS}; do
  printf "\n  ${BOLD}%s:${NC}\n" "${cloud}"

  cloud_pass=0
  cloud_fail=0

  for agent in ${AGENTS_TO_TEST}; do
    result_file="${LOG_DIR}/${cloud}-${agent}.result"
    if [ -f "${result_file}" ] && [ "$(cat "${result_file}")" = "pass" ]; then
      printf "    ${GREEN}%-12s PASS${NC}\n" "${agent}"
      cloud_pass=$((cloud_pass + 1))
      total_pass=$((total_pass + 1))
    else
      printf "    ${RED}%-12s FAIL${NC}\n" "${agent}"
      cloud_fail=$((cloud_fail + 1))
      total_fail=$((total_fail + 1))
    fi
  done

  if [ "${cloud_fail}" -gt 0 ]; then
    printf "    ${RED}%d passed, %d failed${NC}\n" "${cloud_pass}" "${cloud_fail}"
    any_cloud_failed=1
  else
    printf "    ${GREEN}%d passed, 0 failed${NC}\n" "${cloud_pass}"
  fi
done

printf "\n"
printf "  ${BOLD}Total:${NC} ${GREEN}%d passed${NC}" "${total_pass}"
if [ "${total_fail}" -gt 0 ]; then
  printf ", ${RED}%d failed${NC}" "${total_fail}"
fi
printf "\n  Duration: %s\n" "${DURATION_STR}"

# Exit with failure if any agent on any cloud failed
if [ "${total_fail}" -gt 0 ]; then
  exit 1
fi

exit 0
