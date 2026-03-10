#!/bin/bash
# e2e/lib/common.sh — Constants, logging, env validation for multi-cloud E2E
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALL_AGENTS="claude openclaw zeroclaw codex opencode kilocode hermes junie"
PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-720}"
INSTALL_WAIT="${INSTALL_WAIT:-600}"
INPUT_TEST_TIMEOUT="${INPUT_TEST_TIMEOUT:-120}"
# Validate numeric env vars that get interpolated into remote command strings.
# A non-numeric value here could lead to shell injection via SSH commands.
case "${PROVISION_TIMEOUT}" in ''|*[!0-9]*) PROVISION_TIMEOUT=720 ;; esac
case "${INSTALL_WAIT}" in ''|*[!0-9]*) INSTALL_WAIT=600 ;; esac
case "${INPUT_TEST_TIMEOUT}" in ''|*[!0-9]*) INPUT_TEST_TIMEOUT=120 ;; esac

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
  printf '\n%b%b%s=== %s ===%b\n' "$BOLD" "$BLUE" "${CLOUD_LOG_PREFIX}" "$1" "$NC"
}

log_step() {
  printf '%b%s  -> %s%b\n' "$CYAN" "${CLOUD_LOG_PREFIX}" "$1" "$NC"
}

log_ok() {
  printf '%b%s  [PASS] %s%b\n' "$GREEN" "${CLOUD_LOG_PREFIX}" "$1" "$NC"
}

log_err() {
  printf '%b%s  [FAIL] %s%b\n' "$RED" "${CLOUD_LOG_PREFIX}" "$1" "$NC"
}

log_warn() {
  printf '%b%s  [WARN] %s%b\n' "$YELLOW" "${CLOUD_LOG_PREFIX}" "$1" "$NC"
}

log_info() {
  printf '%b%s  [INFO] %s%b\n' "$BLUE" "${CLOUD_LOG_PREFIX}" "$1" "$NC"
}

# ---------------------------------------------------------------------------
# load_cloud_driver CLOUD
#
# Sources the cloud-specific driver and sets ACTIVE_CLOUD for wrapper dispatch.
# NOTE: Uses BASH_SOURCE and source with a filesystem path. This is intentional —
# e2e scripts are always run from the filesystem, never via bash <(curl ...).
# ---------------------------------------------------------------------------
load_cloud_driver() {
  local cloud="$1"
  ACTIVE_CLOUD="${cloud}"

  # Resolve driver file (relative to this script's location).
  # BASH_SOURCE[0] is safe here — e2e scripts run from disk, not curl|bash.
  local driver_dir
  driver_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/clouds"
  local driver_file="${driver_dir}/${cloud}.sh"

  if [ ! -f "${driver_file}" ]; then
    log_err "Cloud driver not found: ${driver_file}"
    return 1
  fi

  # shellcheck source=/dev/null  # driver path is dynamic
  source "${driver_file}"

  log_step "Loaded cloud driver: ${cloud}"
}

# ---------------------------------------------------------------------------
# Cloud wrapper functions — use ACTIVE_CLOUD for indirection (set by load_cloud_driver)
# ---------------------------------------------------------------------------
cloud_validate_env()     { "_${ACTIVE_CLOUD}_validate_env" "$@"; }
cloud_headless_env()     { "_${ACTIVE_CLOUD}_headless_env" "$@"; }
cloud_provision_verify() { "_${ACTIVE_CLOUD}_provision_verify" "$@"; }
cloud_exec()             { "_${ACTIVE_CLOUD}_exec" "$@"; }
cloud_teardown()         { "_${ACTIVE_CLOUD}_teardown" "$@"; }
cloud_cleanup_stale()    { "_${ACTIVE_CLOUD}_cleanup_stale" "$@"; }

cloud_max_parallel() {
  if type "_${ACTIVE_CLOUD}_max_parallel" >/dev/null 2>&1; then
    "_${ACTIVE_CLOUD}_max_parallel" "$@"
  else
    printf '99'
  fi
}

cloud_install_wait() {
  if type "_${ACTIVE_CLOUD}_install_wait" >/dev/null 2>&1; then
    "_${ACTIVE_CLOUD}_install_wait" "$@"
  else
    printf '%s' "${INSTALL_WAIT}"
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
  # Include ACTIVE_CLOUD to avoid name collisions in multi-cloud parallel runs
  if [ -n "${ACTIVE_CLOUD:-}" ]; then
    printf "e2e-%s-%s-%s" "${ACTIVE_CLOUD}" "${agent}" "${ts}"
  else
    printf "e2e-%s-%s" "${agent}" "${ts}"
  fi
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
