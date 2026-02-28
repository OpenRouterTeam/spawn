#!/bin/bash
# e2e/lib/common.sh — Constants, logging, env validation for multi-cloud E2E
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALL_AGENTS="claude openclaw zeroclaw codex opencode kilocode"
PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-480}"
INSTALL_WAIT="${INSTALL_WAIT:-300}"
INPUT_TEST_TIMEOUT="${INPUT_TEST_TIMEOUT:-120}"

# Active cloud (set by load_cloud_driver)
ACTIVE_CLOUD=""

# Cloud log prefix for multi-cloud parallel output
CLOUD_LOG_PREFIX=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Tracked instances for cleanup on exit
_TRACKED_APPS=""

# ---------------------------------------------------------------------------
# Logging (with optional cloud prefix for parallel output)
# ---------------------------------------------------------------------------
log_header() {
  printf "\n${BOLD}${BLUE}%s=== %s ===${NC}\n" "${CLOUD_LOG_PREFIX}" "$1"
}

log_step() {
  printf "${CYAN}%s  -> %s${NC}\n" "${CLOUD_LOG_PREFIX}" "$1"
}

log_ok() {
  printf "${GREEN}%s  [PASS] %s${NC}\n" "${CLOUD_LOG_PREFIX}" "$1"
}

log_err() {
  printf "${RED}%s  [FAIL] %s${NC}\n" "${CLOUD_LOG_PREFIX}" "$1"
}

log_warn() {
  printf "${YELLOW}%s  [WARN] %s${NC}\n" "${CLOUD_LOG_PREFIX}" "$1"
}

log_info() {
  printf "${BLUE}%s  [INFO] %s${NC}\n" "${CLOUD_LOG_PREFIX}" "$1"
}

# ---------------------------------------------------------------------------
# load_cloud_driver CLOUD
#
# Sources the cloud-specific driver and creates generic wrappers.
# ---------------------------------------------------------------------------
load_cloud_driver() {
  local cloud="$1"
  ACTIVE_CLOUD="${cloud}"

  # Resolve driver file (relative to this script's location)
  local driver_dir
  driver_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/clouds"
  local driver_file="${driver_dir}/${cloud}.sh"

  if [ ! -f "${driver_file}" ]; then
    log_err "Cloud driver not found: ${driver_file}"
    return 1
  fi

  source "${driver_file}"

  # Create generic wrappers that delegate to cloud-specific functions
  eval "cloud_validate_env() { _${cloud}_validate_env \"\$@\"; }"
  eval "cloud_headless_env() { _${cloud}_headless_env \"\$@\"; }"
  eval "cloud_provision_verify() { _${cloud}_provision_verify \"\$@\"; }"
  eval "cloud_exec() { _${cloud}_exec \"\$@\"; }"
  eval "cloud_exec_long() { _${cloud}_exec_long \"\$@\"; }"
  eval "cloud_teardown() { _${cloud}_teardown \"\$@\"; }"
  eval "cloud_cleanup_stale() { _${cloud}_cleanup_stale \"\$@\"; }"

  # Optional: per-cloud parallelism cap (returns max agents to run concurrently)
  if type "_${cloud}_max_parallel" >/dev/null 2>&1; then
    eval "cloud_max_parallel() { _${cloud}_max_parallel \"\$@\"; }"
  else
    # Default: no cap (return a large number)
    eval "cloud_max_parallel() { printf '99'; }"
  fi

  # Optional: per-cloud install wait override (seconds to poll for .spawnrc)
  if type "_${cloud}_install_wait" >/dev/null 2>&1; then
    eval "cloud_install_wait() { _${cloud}_install_wait \"\$@\"; }"
  else
    eval "cloud_install_wait() { printf '%s' \"\${INSTALL_WAIT}\"; }"
  fi
}

# ---------------------------------------------------------------------------
# require_common_env
#
# Validates tools and env vars common to ALL clouds (bun, jq, OPENROUTER_API_KEY).
# Cloud-specific validation is handled by cloud_validate_env().
# ---------------------------------------------------------------------------
require_common_env() {
  local missing=0

  if ! command -v jq >/dev/null 2>&1; then
    log_err "jq not found. Install via: brew install jq / apt install jq"
    missing=1
  fi

  if ! command -v bun >/dev/null 2>&1; then
    log_err "bun not found. Install from https://bun.sh"
    missing=1
  fi

  if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    log_err "OPENROUTER_API_KEY is not set"
    missing=1
  fi

  if [ "${missing}" -eq 1 ]; then
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# require_env
#
# Validates common env + active cloud-specific env.
# ---------------------------------------------------------------------------
require_env() {
  if ! require_common_env; then
    return 1
  fi

  if ! cloud_validate_env; then
    return 1
  fi

  log_ok "Environment validated"
  return 0
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
make_app_name() {
  local agent="$1"
  local ts
  ts=$(date +%s)
  printf "e2e-%s-%s" "${agent}" "${ts}"
}

format_duration() {
  local seconds="$1"
  local mins=$((seconds / 60))
  local secs=$((seconds % 60))
  printf "%dm %ds" "${mins}" "${secs}"
}

track_app() {
  local app_name="$1"
  if [ -z "${_TRACKED_APPS}" ]; then
    _TRACKED_APPS="${app_name}"
  else
    _TRACKED_APPS="${_TRACKED_APPS} ${app_name}"
  fi
}

untrack_app() {
  local app_name="$1"
  local new_list=""
  for app in ${_TRACKED_APPS}; do
    if [ "${app}" != "${app_name}" ]; then
      if [ -z "${new_list}" ]; then
        new_list="${app}"
      else
        new_list="${new_list} ${app}"
      fi
    fi
  done
  _TRACKED_APPS="${new_list}"
}
