#!/bin/bash
# e2e/lib/common.sh — Constants, logging, env validation for multi-cloud E2E
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALL_AGENTS="claude openclaw codex opencode kilocode hermes junie cursor"
PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-720}"
INSTALL_WAIT="${INSTALL_WAIT:-600}"
INPUT_TEST_TIMEOUT="${INPUT_TEST_TIMEOUT:-120}"
# Per-agent overall timeout: max wall-clock time for provision + verify + input test.
# Ensures a result file is always written even if a step hangs indefinitely.
AGENT_TIMEOUT="${AGENT_TIMEOUT:-1800}"
# Validate numeric env vars that get interpolated into remote command strings.
# A non-numeric value here could lead to shell injection via SSH commands.
case "${PROVISION_TIMEOUT}" in ''|*[!0-9]*) PROVISION_TIMEOUT=720 ;; esac
case "${INSTALL_WAIT}" in ''|*[!0-9]*) INSTALL_WAIT=600 ;; esac
case "${INPUT_TEST_TIMEOUT}" in ''|*[!0-9]*) INPUT_TEST_TIMEOUT=120 ;; esac
case "${AGENT_TIMEOUT}" in ''|*[!0-9]*) AGENT_TIMEOUT=1800 ;; esac

# ---------------------------------------------------------------------------
# OpenRouter API key fallback
#
# On QA VMs that run Claude Code via OpenRouter, the API key is stored as
# ANTHROPIC_AUTH_TOKEN (because Claude Code uses ANTHROPIC_BASE_URL + token).
# Export OPENROUTER_API_KEY from ANTHROPIC_AUTH_TOKEN when using OpenRouter.
# ---------------------------------------------------------------------------
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  case "${ANTHROPIC_BASE_URL:-}" in
    *openrouter*)
      export OPENROUTER_API_KEY="${ANTHROPIC_AUTH_TOKEN}"
      ;;
  esac
fi

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

# Refresh auth token if the cloud driver supports it (e.g. Sprite tokens
# expire after ~60 min). Called before each provisioning batch to prevent
# auth expiry failures in long-running E2E suites. See #2934.
cloud_refresh_auth() {
  if type "_${ACTIVE_CLOUD}_refresh_auth" >/dev/null 2>&1; then
    "_${ACTIVE_CLOUD}_refresh_auth" "$@"
  fi
}

# ---------------------------------------------------------------------------
# Per-agent provision timeout overrides
#
# Some agents (e.g. junie) have heavier installs that exceed the default
# PROVISION_TIMEOUT on slower clouds. This map lets us set per-agent defaults
# without raising the global timeout for all agents.
#
# Override precedence:
#   1. PROVISION_TIMEOUT_<agent> env var (explicit override)
#   2. Built-in per-agent default (below)
#   3. Global PROVISION_TIMEOUT
# ---------------------------------------------------------------------------
_PROVISION_TIMEOUT_junie=1200
_AGENT_TIMEOUT_junie=2400
# Hermes installs a Python virtualenv which can take 20+ min on slow VMs.
# Provision timeout bumped to match the CLI install timeout (600s).
# Agent timeout bumped to 3600s to give the install enough headroom.
_PROVISION_TIMEOUT_hermes=720
_AGENT_TIMEOUT_hermes=3600

get_provision_timeout() {
  local agent="$1"
  # Sanitize agent name: whitelist [A-Za-z0-9_] only, replacing all else with _
  # This prevents shell metacharacter injection before eval on lines below
  local safe_agent
  safe_agent=$(printf '%s' "${agent}" | sed 's/[^A-Za-z0-9_]/_/g')

  # Check for env var override: PROVISION_TIMEOUT_<agent>
  local env_var="PROVISION_TIMEOUT_${safe_agent}"
  eval "local env_val=\${${env_var}:-}"
  if [ -n "${env_val}" ]; then
    case "${env_val}" in ''|*[!0-9]*) ;; *) printf '%s' "${env_val}"; return ;; esac
  fi

  # Check for built-in per-agent default
  local builtin_var="_PROVISION_TIMEOUT_${safe_agent}"
  eval "local builtin_val=\${${builtin_var}:-}"
  if [ -n "${builtin_val}" ]; then
    printf '%s' "${builtin_val}"
    return
  fi

  # Fall back to global
  printf '%s' "${PROVISION_TIMEOUT}"
}

# ---------------------------------------------------------------------------
# get_agent_timeout AGENT
#
# Returns the overall wall-clock timeout (seconds) for a single agent run
# (provision + verify + input test). Same override precedence as above:
#   1. AGENT_TIMEOUT_<agent> env var
#   2. Built-in per-agent default (_AGENT_TIMEOUT_<agent>)
#   3. Global AGENT_TIMEOUT
# ---------------------------------------------------------------------------
get_agent_timeout() {
  local agent="$1"
  local safe_agent
  safe_agent=$(printf '%s' "${agent}" | sed 's/[^A-Za-z0-9_]/_/g')

  # Check for env var override: AGENT_TIMEOUT_<agent>
  local env_var="AGENT_TIMEOUT_${safe_agent}"
  eval "local env_val=\${${env_var}:-}"
  if [ -n "${env_val}" ]; then
    case "${env_val}" in ''|*[!0-9]*) ;; *) printf '%s' "${env_val}"; return ;; esac
  fi

  # Check for built-in per-agent default
  local builtin_var="_AGENT_TIMEOUT_${safe_agent}"
  eval "local builtin_val=\${${builtin_var}:-}"
  if [ -n "${builtin_val}" ]; then
    printf '%s' "${builtin_val}"
    return
  fi

  # Fall back to global
  printf '%s' "${AGENT_TIMEOUT}"
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
