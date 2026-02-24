#!/bin/bash
# e2e/lib/common.sh — Constants, logging, env validation, Fly API helpers
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALL_AGENTS="claude openclaw zeroclaw codex opencode kilocode"
FLY_API_BASE="https://api.machines.dev/v1"
PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-480}"
INSTALL_WAIT="${INSTALL_WAIT:-120}"
FLY_REGION="${FLY_REGION:-iad}"
FLY_VM_MEMORY="${FLY_VM_MEMORY:-2048}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Tracked apps for cleanup on exit
_TRACKED_APPS=""

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log_header() {
  printf "\n${BOLD}${BLUE}=== %s ===${NC}\n" "$1"
}

log_step() {
  printf "${CYAN}  -> %s${NC}\n" "$1"
}

log_ok() {
  printf "${GREEN}  [PASS] %s${NC}\n" "$1"
}

log_err() {
  printf "${RED}  [FAIL] %s${NC}\n" "$1"
}

log_warn() {
  printf "${YELLOW}  [WARN] %s${NC}\n" "$1"
}

log_info() {
  printf "${BLUE}  [INFO] %s${NC}\n" "$1"
}

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------
require_env() {
  local missing=0

  # Check required tools
  if ! command -v flyctl >/dev/null 2>&1; then
    log_err "flyctl not found. Install from https://fly.io/docs/flyctl/install/"
    missing=1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    log_err "jq not found. Install via: brew install jq / apt install jq"
    missing=1
  fi

  if ! command -v bun >/dev/null 2>&1; then
    log_err "bun not found. Install from https://bun.sh"
    missing=1
  fi

  # Check OPENROUTER_API_KEY
  if [ -z "${OPENROUTER_API_KEY:-}" ]; then
    log_err "OPENROUTER_API_KEY is not set"
    missing=1
  fi

  # Check / generate FLY_API_TOKEN
  if [ -z "${FLY_API_TOKEN:-}" ]; then
    log_info "FLY_API_TOKEN not set, generating via flyctl..."
    FLY_API_TOKEN=$(flyctl tokens create org personal --expiry 2h 2>/dev/null || true)
    if [ -z "${FLY_API_TOKEN:-}" ]; then
      log_warn "Could not generate token. Falling back to flyctl stored credentials."
      # Validate flyctl is authenticated
      if ! flyctl auth whoami >/dev/null 2>&1; then
        log_err "flyctl is not authenticated. Run: flyctl auth login"
        missing=1
      fi
    else
      export FLY_API_TOKEN
      log_ok "Generated FLY_API_TOKEN (expires in 2h)"
    fi
  fi

  if [ "${missing}" -eq 1 ]; then
    return 1
  fi

  log_ok "Environment validated"
  return 0
}

# ---------------------------------------------------------------------------
# Fly API helper
# ---------------------------------------------------------------------------
# fly_api METHOD ENDPOINT [BODY]
# Calls the Fly Machines REST API.
fly_api() {
  local method="$1"
  local endpoint="$2"
  local body="${3:-}"
  local url="${FLY_API_BASE}${endpoint}"
  local auth_header

  # Detect token format for auth header
  local token="${FLY_API_TOKEN:-}"
  if [ -z "${token}" ]; then
    # If no token, try to get one from flyctl
    token=$(flyctl auth token 2>/dev/null || true)
  fi

  if [ -z "${token}" ]; then
    log_err "No Fly API token available"
    return 1
  fi

  # FlyV1 tokens start with FlyV1, otherwise use Bearer
  case "${token}" in
    FlyV1\ *) auth_header="Authorization: ${token}" ;;
    *)        auth_header="Authorization: Bearer ${token}" ;;
  esac

  local curl_args=("-s" "-X" "${method}" "-H" "${auth_header}" "-H" "Content-Type: application/json")
  if [ -n "${body}" ]; then
    curl_args+=("-d" "${body}")
  fi

  curl "${curl_args[@]}" "${url}"
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
