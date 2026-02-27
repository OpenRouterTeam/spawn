#!/bin/bash
# e2e/lib/common.sh — Constants, logging, env validation for AWS Lightsail E2E
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALL_AGENTS="claude openclaw zeroclaw codex opencode kilocode"
PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-480}"
INSTALL_WAIT="${INSTALL_WAIT:-120}"
INPUT_TEST_TIMEOUT="${INPUT_TEST_TIMEOUT:-120}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_BUNDLE="${AWS_BUNDLE:-nano_3_0}"

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
  if ! command -v aws >/dev/null 2>&1; then
    log_err "aws CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
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

  # Validate AWS credentials
  if ! aws sts get-caller-identity --region "${AWS_REGION}" >/dev/null 2>&1; then
    log_err "AWS credentials are not valid. Run: aws configure"
    missing=1
  else
    log_ok "AWS credentials validated"
  fi

  if [ "${missing}" -eq 1 ]; then
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
