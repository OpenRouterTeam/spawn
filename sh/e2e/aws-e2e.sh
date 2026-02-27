#!/bin/bash
# sh/e2e/aws-e2e.sh — Main E2E test orchestrator for Spawn on AWS Lightsail
#
# Usage:
#   ./sh/e2e/aws-e2e.sh                       # All agents, sequential
#   ./sh/e2e/aws-e2e.sh claude                # Single agent
#   ./sh/e2e/aws-e2e.sh claude codex opencode # Specific agents
#   ./sh/e2e/aws-e2e.sh --parallel 2          # Parallel (2 at a time)
#   ./sh/e2e/aws-e2e.sh --skip-cleanup        # Skip stale instance cleanup
#   ./sh/e2e/aws-e2e.sh --skip-input-test     # Skip live input tests
set -eo pipefail

# ---------------------------------------------------------------------------
# Resolve script directory and source libraries
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"
source "${SCRIPT_DIR}/lib/provision.sh"
source "${SCRIPT_DIR}/lib/verify.sh"
source "${SCRIPT_DIR}/lib/teardown.sh"
source "${SCRIPT_DIR}/lib/cleanup.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
AGENTS_TO_TEST=""
PARALLEL_COUNT=0
SKIP_CLEANUP=0
SKIP_INPUT_TEST="${SKIP_INPUT_TEST:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --parallel)
      shift
      if [ $# -eq 0 ]; then
        printf "Error: --parallel requires a number\n" >&2
        exit 1
      fi
      PARALLEL_COUNT="$1"
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
      printf "Usage: %s [agent1 agent2 ...] [--parallel N] [--skip-cleanup] [--skip-input-test]\n" "$0"
      printf "\nAgents: %s\n" "${ALL_AGENTS}"
      printf "\nOptions:\n"
      printf "  --parallel N       Run N agents in parallel (default: sequential)\n"
      printf "  --skip-cleanup     Skip stale e2e-* instance cleanup\n"
      printf "  --skip-input-test  Skip live input tests (send prompt, check response)\n"
      printf "  --help             Show this help\n"
      exit 0
      ;;
    -*)
      printf "Unknown option: %s\n" "$1" >&2
      exit 1
      ;;
    *)
      # Validate agent name
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

# Default to all agents
if [ -z "${AGENTS_TO_TEST}" ]; then
  AGENTS_TO_TEST="${ALL_AGENTS}"
fi

# ---------------------------------------------------------------------------
# Final cleanup trap — tear down any tracked instances on exit
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
  # Clean up temp log directory
  if [ -n "${LOG_DIR:-}" ] && [ -d "${LOG_DIR:-}" ]; then
    rm -rf "${LOG_DIR}"
  fi
}
trap final_cleanup EXIT

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log_header "Spawn E2E Test Suite (AWS Lightsail)"
log_info "Agents: ${AGENTS_TO_TEST}"
log_info "Parallel: ${PARALLEL_COUNT:-sequential}"
if [ "${SKIP_INPUT_TEST}" -eq 1 ]; then
  log_info "Input tests: SKIPPED"
fi

# Validate environment
if ! require_env; then
  log_err "Environment validation failed"
  exit 1
fi

# Create temp log directory
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spawn-e2e.XXXXXX")
log_info "Log directory: ${LOG_DIR}"

START_TIME=$(date +%s)

# Result tracking (space-separated lists)
PASSED=""
FAILED=""
SKIPPED=""

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

  # Provision → Verify → Input Test
  if provision_agent "${agent}" "${app_name}" "${LOG_DIR}"; then
    # Verify
    if verify_agent "${agent}" "${app_name}"; then
      # Input test (only runs if verify passes)
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
  else
    # Sequential mode: update global variables directly
    if [ "${status}" = "pass" ]; then
      if [ -z "${PASSED}" ]; then PASSED="${agent}"; else PASSED="${PASSED} ${agent}"; fi
    else
      if [ -z "${FAILED}" ]; then FAILED="${agent}"; else FAILED="${FAILED} ${agent}"; fi
    fi
  fi
}

# ---------------------------------------------------------------------------
# Execute tests
# ---------------------------------------------------------------------------
if [ "${PARALLEL_COUNT}" -gt 0 ]; then
  # Parallel mode: batch agents into groups of N
  log_info "Running in parallel mode (batch size: ${PARALLEL_COUNT})"

  # Convert agent list to indexed array
  agent_array=""
  agent_count=0
  for a in ${AGENTS_TO_TEST}; do
    agent_array="${agent_array} ${a}"
    agent_count=$((agent_count + 1))
  done

  batch_num=0
  batch_agents=""
  batch_count=0

  for agent in ${agent_array}; do
    batch_agents="${batch_agents} ${agent}"
    batch_count=$((batch_count + 1))

    if [ "${batch_count}" -ge "${PARALLEL_COUNT}" ]; then
      # Run this batch
      batch_num=$((batch_num + 1))
      log_header "Batch ${batch_num}"

      pids=""
      for ba in ${batch_agents}; do
        local_result_file="${LOG_DIR}/${ba}.result"
        run_single_agent "${ba}" "${local_result_file}" &
        if [ -z "${pids}" ]; then pids="$!"; else pids="${pids} $!"; fi
      done

      # Wait for all PIDs in this batch
      for p in ${pids}; do
        wait "${p}" 2>/dev/null || true
      done

      # Collect results
      for ba in ${batch_agents}; do
        local_result_file="${LOG_DIR}/${ba}.result"
        if [ -f "${local_result_file}" ]; then
          local_result=$(cat "${local_result_file}")
          if [ "${local_result}" = "pass" ]; then
            if [ -z "${PASSED}" ]; then PASSED="${ba}"; else PASSED="${PASSED} ${ba}"; fi
          else
            if [ -z "${FAILED}" ]; then FAILED="${ba}"; else FAILED="${FAILED} ${ba}"; fi
          fi
        else
          if [ -z "${FAILED}" ]; then FAILED="${ba}"; else FAILED="${FAILED} ${ba}"; fi
        fi
      done

      batch_agents=""
      batch_count=0
    fi
  done

  # Handle remaining agents in last partial batch
  if [ -n "${batch_agents}" ]; then
    batch_num=$((batch_num + 1))
    log_header "Batch ${batch_num}"

    pids=""
    for ba in ${batch_agents}; do
      local_result_file="${LOG_DIR}/${ba}.result"
      run_single_agent "${ba}" "${local_result_file}" &
      if [ -z "${pids}" ]; then pids="$!"; else pids="${pids} $!"; fi
    done

    for p in ${pids}; do
      wait "${p}" 2>/dev/null || true
    done

    for ba in ${batch_agents}; do
      local_result_file="${LOG_DIR}/${ba}.result"
      if [ -f "${local_result_file}" ]; then
        local_result=$(cat "${local_result_file}")
        if [ "${local_result}" = "pass" ]; then
          if [ -z "${PASSED}" ]; then PASSED="${ba}"; else PASSED="${PASSED} ${ba}"; fi
        else
          if [ -z "${FAILED}" ]; then FAILED="${ba}"; else FAILED="${FAILED} ${ba}"; fi
        fi
      else
        if [ -z "${FAILED}" ]; then FAILED="${ba}"; else FAILED="${FAILED} ${ba}"; fi
      fi
    done
  fi

else
  # Sequential mode
  for agent in ${AGENTS_TO_TEST}; do
    run_single_agent "${agent}"
  done
fi

# ---------------------------------------------------------------------------
# Stale cleanup
# ---------------------------------------------------------------------------
if [ "${SKIP_CLEANUP}" -eq 0 ]; then
  cleanup_stale_apps || log_warn "Stale cleanup encountered errors"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))
DURATION_STR=$(format_duration "${TOTAL_DURATION}")

# Count results
pass_count=0
fail_count=0
skip_count=0

for _ in ${PASSED}; do pass_count=$((pass_count + 1)); done
for _ in ${FAILED}; do fail_count=$((fail_count + 1)); done
for _ in ${SKIPPED}; do skip_count=$((skip_count + 1)); done

printf "\n"
log_header "E2E Test Summary"
printf "${GREEN}  Passed:  %d${NC}\n" "${pass_count}"
if [ "${fail_count}" -gt 0 ]; then
  printf "${RED}  Failed:  %d${NC}\n" "${fail_count}"
else
  printf "  Failed:  %d\n" "${fail_count}"
fi
if [ "${skip_count}" -gt 0 ]; then
  printf "${YELLOW}  Skipped: %d${NC}\n" "${skip_count}"
fi
printf "  Duration: %s\n" "${DURATION_STR}"

if [ -n "${PASSED}" ]; then
  printf "${GREEN}  Passed agents: %s${NC}\n" "${PASSED}"
fi
if [ -n "${FAILED}" ]; then
  printf "${RED}  Failed agents: %s${NC}\n" "${FAILED}"
fi

# Exit with failure if any agent failed
if [ "${fail_count}" -gt 0 ]; then
  exit 1
fi

exit 0
