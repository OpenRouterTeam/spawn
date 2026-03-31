#!/bin/bash
# sh/test/e2e-lib.sh — Unit tests for E2E library functions (common.sh, verify.sh, provision.sh)
#
# Tests pure functions without requiring cloud credentials or remote instances.
# Bash 3.2 compatible (no set -u, no echo -e, no (( ++ ))).
#
# Usage:
#   bash sh/test/e2e-lib.sh
set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
_TESTS_RUN=0
_TESTS_PASSED=0
_TESTS_FAILED=0
_FAIL_DETAILS=""

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  _TESTS_RUN=$((_TESTS_RUN + 1))
  if [ "${expected}" = "${actual}" ]; then
    _TESTS_PASSED=$((_TESTS_PASSED + 1))
  else
    _TESTS_FAILED=$((_TESTS_FAILED + 1))
    _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: ${label}\n    expected: '${expected}'\n    actual:   '${actual}'"
  fi
}

assert_match() {
  local label="$1"
  local pattern="$2"
  local actual="$3"
  _TESTS_RUN=$((_TESTS_RUN + 1))
  if printf '%s' "${actual}" | grep -qE "${pattern}"; then
    _TESTS_PASSED=$((_TESTS_PASSED + 1))
  else
    _TESTS_FAILED=$((_TESTS_FAILED + 1))
    _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: ${label}\n    pattern: '${pattern}'\n    actual:  '${actual}'"
  fi
}

assert_exit() {
  local label="$1"
  local expected_exit="$2"
  shift 2
  local actual_exit=0
  "$@" >/dev/null 2>&1 || actual_exit=$?
  _TESTS_RUN=$((_TESTS_RUN + 1))
  if [ "${expected_exit}" -eq "${actual_exit}" ]; then
    _TESTS_PASSED=$((_TESTS_PASSED + 1))
  else
    _TESTS_FAILED=$((_TESTS_FAILED + 1))
    _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: ${label}\n    expected exit: ${expected_exit}\n    actual exit:   ${actual_exit}"
  fi
}

# ---------------------------------------------------------------------------
# Source the libraries under test
# We need to suppress set -e in common.sh since it validates env on source
# ---------------------------------------------------------------------------

# Stub out commands that common.sh checks for (we don't need real ones for unit tests)
export OPENROUTER_API_KEY="test-key-for-unit-tests"

# Source common.sh (provides helpers, constants, logging)
source "${REPO_ROOT}/sh/e2e/lib/common.sh"

# Source verify.sh (provides _validate_timeout, _validate_base64, etc.)
source "${REPO_ROOT}/sh/e2e/lib/verify.sh"

# ===================================================================
# common.sh tests
# ===================================================================

# --- format_duration ---
printf '%b\n' "${BOLD}Testing: format_duration${NC}"

assert_eq "format_duration 0" "0m 0s" "$(format_duration 0)"
assert_eq "format_duration 59" "0m 59s" "$(format_duration 59)"
assert_eq "format_duration 60" "1m 0s" "$(format_duration 60)"
assert_eq "format_duration 61" "1m 1s" "$(format_duration 61)"
assert_eq "format_duration 3661" "61m 1s" "$(format_duration 3661)"
assert_eq "format_duration 120" "2m 0s" "$(format_duration 120)"

# --- make_app_name ---
printf '%b\n' "${BOLD}Testing: make_app_name${NC}"

# Without ACTIVE_CLOUD
ACTIVE_CLOUD=""
result=$(make_app_name "claude")
assert_match "make_app_name claude (no cloud)" '^e2e-claude-[0-9]+$' "${result}"

# With ACTIVE_CLOUD
ACTIVE_CLOUD="aws"
result=$(make_app_name "openclaw")
assert_match "make_app_name openclaw (aws)" '^e2e-aws-openclaw-[0-9]+$' "${result}"

ACTIVE_CLOUD="sprite"
result=$(make_app_name "codex")
assert_match "make_app_name codex (sprite)" '^e2e-sprite-codex-[0-9]+$' "${result}"

# Reset
ACTIVE_CLOUD=""

# --- track_app / untrack_app ---
printf '%b\n' "${BOLD}Testing: track_app / untrack_app${NC}"

_TRACKED_APPS=""
track_app "app-1"
assert_eq "track_app first" "app-1" "${_TRACKED_APPS}"

track_app "app-2"
assert_eq "track_app second" "app-1 app-2" "${_TRACKED_APPS}"

track_app "app-3"
assert_eq "track_app third" "app-1 app-2 app-3" "${_TRACKED_APPS}"

untrack_app "app-2"
assert_eq "untrack_app middle" "app-1 app-3" "${_TRACKED_APPS}"

untrack_app "app-1"
assert_eq "untrack_app first" "app-3" "${_TRACKED_APPS}"

untrack_app "app-3"
assert_eq "untrack_app last" "" "${_TRACKED_APPS}"

# Untrack non-existent (should be no-op)
_TRACKED_APPS="x y z"
untrack_app "w"
assert_eq "untrack_app non-existent" "x y z" "${_TRACKED_APPS}"

_TRACKED_APPS=""

# --- get_provision_timeout ---
printf '%b\n' "${BOLD}Testing: get_provision_timeout${NC}"

# Default agent (no override)
result=$(get_provision_timeout "claude")
assert_eq "get_provision_timeout claude (default)" "${PROVISION_TIMEOUT}" "${result}"

# Junie has a built-in override
result=$(get_provision_timeout "junie")
assert_eq "get_provision_timeout junie (built-in)" "1200" "${result}"

# Env var override takes precedence
export PROVISION_TIMEOUT_codex=999
result=$(get_provision_timeout "codex")
assert_eq "get_provision_timeout codex (env override)" "999" "${result}"
unset PROVISION_TIMEOUT_codex

# Non-numeric env var override is ignored
export PROVISION_TIMEOUT_codex="abc"
result=$(get_provision_timeout "codex")
assert_eq "get_provision_timeout codex (non-numeric env ignored)" "${PROVISION_TIMEOUT}" "${result}"
unset PROVISION_TIMEOUT_codex

# Agent name sanitization (special chars → underscore)
result=$(get_provision_timeout "my-agent")
assert_eq "get_provision_timeout my-agent (sanitized)" "${PROVISION_TIMEOUT}" "${result}"

# --- get_agent_timeout ---
printf '%b\n' "${BOLD}Testing: get_agent_timeout${NC}"

# Default agent
result=$(get_agent_timeout "claude")
assert_eq "get_agent_timeout claude (default)" "${AGENT_TIMEOUT}" "${result}"

# Junie has a built-in override
result=$(get_agent_timeout "junie")
assert_eq "get_agent_timeout junie (built-in)" "2400" "${result}"

# Env var override
export AGENT_TIMEOUT_hermes=500
result=$(get_agent_timeout "hermes")
assert_eq "get_agent_timeout hermes (env override)" "500" "${result}"
unset AGENT_TIMEOUT_hermes

# Non-numeric env var ignored — falls through to built-in hermes default (3600), not global
export AGENT_TIMEOUT_hermes="not-a-number"
result=$(get_agent_timeout "hermes")
assert_eq "get_agent_timeout hermes (non-numeric ignored)" "3600" "${result}"
unset AGENT_TIMEOUT_hermes

# --- Numeric validation (constants) ---
printf '%b\n' "${BOLD}Testing: numeric validation${NC}"

# The constants should be numeric after common.sh's validation
assert_match "PROVISION_TIMEOUT is numeric" '^[0-9]+$' "${PROVISION_TIMEOUT}"
assert_match "INSTALL_WAIT is numeric" '^[0-9]+$' "${INSTALL_WAIT}"
assert_match "INPUT_TEST_TIMEOUT is numeric" '^[0-9]+$' "${INPUT_TEST_TIMEOUT}"
assert_match "AGENT_TIMEOUT is numeric" '^[0-9]+$' "${AGENT_TIMEOUT}"

# Verify defaults
assert_eq "PROVISION_TIMEOUT default" "720" "${PROVISION_TIMEOUT}"
assert_eq "INSTALL_WAIT default" "600" "${INSTALL_WAIT}"
assert_eq "INPUT_TEST_TIMEOUT default" "120" "${INPUT_TEST_TIMEOUT}"
assert_eq "AGENT_TIMEOUT default" "1800" "${AGENT_TIMEOUT}"

# Test that non-numeric values get reset to defaults (spawn a subshell)
result=$(INPUT_TEST_TIMEOUT="DROP TABLE;" bash -c 'source "'"${REPO_ROOT}"'/sh/e2e/lib/common.sh" && printf "%s" "${INPUT_TEST_TIMEOUT}"' 2>/dev/null)
assert_eq "INPUT_TEST_TIMEOUT injection reset" "120" "${result}"

result=$(PROVISION_TIMEOUT='$(whoami)' bash -c 'source "'"${REPO_ROOT}"'/sh/e2e/lib/common.sh" && printf "%s" "${PROVISION_TIMEOUT}"' 2>/dev/null)
assert_eq "PROVISION_TIMEOUT injection reset" "720" "${result}"

result=$(AGENT_TIMEOUT="" bash -c 'source "'"${REPO_ROOT}"'/sh/e2e/lib/common.sh" && printf "%s" "${AGENT_TIMEOUT}"' 2>/dev/null)
assert_eq "AGENT_TIMEOUT empty reset" "1800" "${result}"

# --- OpenRouter API key fallback ---
printf '%b\n' "${BOLD}Testing: OpenRouter API key fallback${NC}"

# Test: ANTHROPIC_AUTH_TOKEN with openrouter base URL should set OPENROUTER_API_KEY
result=$(
  unset OPENROUTER_API_KEY
  ANTHROPIC_AUTH_TOKEN="sk-or-test-123" \
  ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
  bash -c 'source "'"${REPO_ROOT}"'/sh/e2e/lib/common.sh" && printf "%s" "${OPENROUTER_API_KEY:-}"' 2>/dev/null
)
assert_eq "API key fallback (openrouter URL)" "sk-or-test-123" "${result}"

# Test: non-openrouter base URL should NOT set OPENROUTER_API_KEY
result=$(
  unset OPENROUTER_API_KEY
  ANTHROPIC_AUTH_TOKEN="sk-ant-test-456" \
  ANTHROPIC_BASE_URL="https://api.anthropic.com" \
  bash -c 'source "'"${REPO_ROOT}"'/sh/e2e/lib/common.sh" && printf "%s" "${OPENROUTER_API_KEY:-}"' 2>/dev/null
)
assert_eq "API key fallback (non-openrouter URL)" "" "${result}"

# Test: existing OPENROUTER_API_KEY should NOT be overwritten
result=$(
  OPENROUTER_API_KEY="existing-key" \
  ANTHROPIC_AUTH_TOKEN="sk-or-new-key" \
  ANTHROPIC_BASE_URL="https://openrouter.ai/api" \
  bash -c 'source "'"${REPO_ROOT}"'/sh/e2e/lib/common.sh" && printf "%s" "${OPENROUTER_API_KEY}"' 2>/dev/null
)
assert_eq "API key fallback (existing key preserved)" "existing-key" "${result}"

# --- cloud_max_parallel / cloud_install_wait defaults ---
printf '%b\n' "${BOLD}Testing: cloud_max_parallel / cloud_install_wait defaults${NC}"

# When no cloud-specific function exists, should return defaults
ACTIVE_CLOUD="nonexistent"
result=$(cloud_max_parallel 2>/dev/null)
assert_eq "cloud_max_parallel default" "99" "${result}"

result=$(cloud_install_wait 2>/dev/null)
assert_eq "cloud_install_wait default" "${INSTALL_WAIT}" "${result}"


# ===================================================================
# verify.sh tests
# ===================================================================

# --- _validate_timeout ---
printf '%b\n' "${BOLD}Testing: _validate_timeout${NC}"

INPUT_TEST_TIMEOUT=120
assert_exit "_validate_timeout valid (120)" 0 _validate_timeout

INPUT_TEST_TIMEOUT=0
assert_exit "_validate_timeout valid (0)" 0 _validate_timeout

INPUT_TEST_TIMEOUT=99999
assert_exit "_validate_timeout valid (99999)" 0 _validate_timeout

INPUT_TEST_TIMEOUT="abc"
assert_exit "_validate_timeout invalid (abc)" 1 _validate_timeout

INPUT_TEST_TIMEOUT='$(whoami)'
assert_exit "_validate_timeout invalid (injection)" 1 _validate_timeout

INPUT_TEST_TIMEOUT=""
assert_exit "_validate_timeout invalid (empty)" 1 _validate_timeout

INPUT_TEST_TIMEOUT="12 34"
assert_exit "_validate_timeout invalid (space)" 1 _validate_timeout

INPUT_TEST_TIMEOUT="120;rm -rf /"
assert_exit "_validate_timeout invalid (semicolon injection)" 1 _validate_timeout

# Reset to valid
INPUT_TEST_TIMEOUT=120

# --- _validate_base64 ---
printf '%b\n' "${BOLD}Testing: _validate_base64${NC}"

assert_exit "_validate_base64 valid" 0 _validate_base64 "SGVsbG8gV29ybGQ="
assert_exit "_validate_base64 valid (no padding)" 0 _validate_base64 "SGVsbG8"
assert_exit "_validate_base64 valid (with +/)" 0 _validate_base64 "abc+def/ghi="
assert_exit "_validate_base64 empty" 1 _validate_base64 ""
assert_exit "_validate_base64 invalid (spaces)" 1 _validate_base64 "SGVs bG8="
assert_exit "_validate_base64 invalid (shell metachar)" 1 _validate_base64 'SGVsbG8;rm -rf /'
assert_exit "_validate_base64 invalid (backtick)" 1 _validate_base64 'SGVsbG8`whoami`'
assert_exit "_validate_base64 invalid (dollar)" 1 _validate_base64 'SGVsbG8$(id)'
# NOTE: _validate_base64 uses grep which matches per-line, so a string with
# newlines passes if each line is individually valid. This is a known limitation
# but low risk — the base64 encoding step always strips newlines (tr -d '\n'),
# and the data is piped via stdin, never interpolated into commands.
assert_exit "_validate_base64 newline (known: passes per-line)" 0 _validate_base64 "$(printf 'SGVs\nbG8=')"

# --- run_input_test dispatch ---
printf '%b\n' "${BOLD}Testing: run_input_test dispatch${NC}"

# Unknown agent should fail
assert_exit "run_input_test unknown agent" 1 run_input_test "nonexistent-agent" "fake-app"

# SKIP_INPUT_TEST=1 should succeed for any agent
SKIP_INPUT_TEST=1
assert_exit "run_input_test skipped" 0 run_input_test "claude" "fake-app"
SKIP_INPUT_TEST=0

# TUI-only agents should pass (they return 0 with a skip message)
# These don't need cloud_exec since they skip early
assert_exit "run_input_test opencode (TUI skip)" 0 run_input_test "opencode" "fake-app"
assert_exit "run_input_test kilocode (TUI skip)" 0 run_input_test "kilocode" "fake-app"
assert_exit "run_input_test hermes (TUI skip)" 0 run_input_test "hermes" "fake-app"
assert_exit "run_input_test junie (not implemented skip)" 0 run_input_test "junie" "fake-app"


# ===================================================================
# provision.sh — app_name validation
# ===================================================================
printf '%b\n' "${BOLD}Testing: provision_agent app_name validation${NC}"

# Source provision.sh
source "${REPO_ROOT}/sh/e2e/lib/provision.sh"

_tmp_log=$(mktemp -d "${TMPDIR:-/tmp}/e2e-test-XXXXXX")

# Valid names should pass validation (will fail later on missing CLI, that's fine)
# We test that invalid names fail BEFORE any CLI interaction

# Empty name
assert_exit "provision_agent empty name" 1 provision_agent "claude" "" "${_tmp_log}"

# Name with shell metacharacters
assert_exit "provision_agent semicolon injection" 1 provision_agent "claude" "app;rm -rf /" "${_tmp_log}"
assert_exit "provision_agent backtick injection" 1 provision_agent "claude" 'app`whoami`' "${_tmp_log}"
assert_exit "provision_agent dollar injection" 1 provision_agent "claude" 'app$(id)' "${_tmp_log}"
assert_exit "provision_agent space in name" 1 provision_agent "claude" "app name" "${_tmp_log}"
assert_exit "provision_agent pipe in name" 1 provision_agent "claude" "app|cat" "${_tmp_log}"

rm -rf "${_tmp_log}"


# ===================================================================
# Integration: e2e.sh argument parsing (via --help, invalid args)
# ===================================================================
printf '%b\n' "${BOLD}Testing: e2e.sh argument parsing${NC}"

E2E_SCRIPT="${REPO_ROOT}/sh/e2e/e2e.sh"

# --help should exit 0
assert_exit "e2e.sh --help" 0 bash "${E2E_SCRIPT}" --help

# No --cloud should exit 1
assert_exit "e2e.sh no args" 1 bash "${E2E_SCRIPT}"

# Unknown cloud should exit 1
assert_exit "e2e.sh unknown cloud" 1 bash "${E2E_SCRIPT}" --cloud fakecloudxyz

# Unknown agent should exit 1
assert_exit "e2e.sh unknown agent" 1 bash "${E2E_SCRIPT}" --cloud aws fakeagentxyz

# Unknown option should exit 1
assert_exit "e2e.sh unknown option" 1 bash "${E2E_SCRIPT}" --cloud aws --bogus

# --parallel without number should exit 1
assert_exit "e2e.sh --parallel no arg" 1 bash "${E2E_SCRIPT}" --cloud aws --parallel

# --parallel 0 should exit 1
assert_exit "e2e.sh --parallel 0" 1 bash "${E2E_SCRIPT}" --cloud aws --parallel 0

# --parallel 999 should exit 1 (> 50)
assert_exit "e2e.sh --parallel 999" 1 bash "${E2E_SCRIPT}" --cloud aws --parallel 999

# --parallel abc should exit 1
assert_exit "e2e.sh --parallel abc" 1 bash "${E2E_SCRIPT}" --cloud aws --parallel abc


# ===================================================================
# ALL_AGENTS constant completeness
# ===================================================================
printf '%b\n' "${BOLD}Testing: ALL_AGENTS completeness${NC}"

# Every agent in ALL_AGENTS should have a verify_* and input_test_* function
for agent in ${ALL_AGENTS}; do
  # Check verify function exists
  if type "verify_${agent}" >/dev/null 2>&1; then
    _TESTS_RUN=$((_TESTS_RUN + 1))
    _TESTS_PASSED=$((_TESTS_PASSED + 1))
  else
    _TESTS_RUN=$((_TESTS_RUN + 1))
    _TESTS_FAILED=$((_TESTS_FAILED + 1))
    _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: verify_${agent} function missing"
  fi

  # Check input_test function exists
  if type "input_test_${agent}" >/dev/null 2>&1; then
    _TESTS_RUN=$((_TESTS_RUN + 1))
    _TESTS_PASSED=$((_TESTS_PASSED + 1))
  else
    _TESTS_RUN=$((_TESTS_RUN + 1))
    _TESTS_FAILED=$((_TESTS_FAILED + 1))
    _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: input_test_${agent} function missing"
  fi
done


# ===================================================================
# Cloud driver interface compliance
# ===================================================================
printf '%b\n' "${BOLD}Testing: cloud driver interface compliance${NC}"

REQUIRED_FUNCTIONS="validate_env headless_env provision_verify exec teardown"

for driver_file in "${REPO_ROOT}"/sh/e2e/lib/clouds/*.sh; do
  driver_name=$(basename "${driver_file}" .sh)

  # Source the driver
  source "${driver_file}"

  for fn in ${REQUIRED_FUNCTIONS}; do
    full_fn="_${driver_name}_${fn}"
    if type "${full_fn}" >/dev/null 2>&1; then
      _TESTS_RUN=$((_TESTS_RUN + 1))
      _TESTS_PASSED=$((_TESTS_PASSED + 1))
    else
      _TESTS_RUN=$((_TESTS_RUN + 1))
      _TESTS_FAILED=$((_TESTS_FAILED + 1))
      _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: ${driver_name} driver missing ${full_fn}()"
    fi
  done
done


# ===================================================================
# Bash syntax check on all E2E scripts
# ===================================================================
printf '%b\n' "${BOLD}Testing: bash -n syntax check on E2E scripts${NC}"

for script in \
  "${REPO_ROOT}/sh/e2e/e2e.sh" \
  "${REPO_ROOT}/sh/e2e/lib/common.sh" \
  "${REPO_ROOT}/sh/e2e/lib/provision.sh" \
  "${REPO_ROOT}/sh/e2e/lib/verify.sh" \
  "${REPO_ROOT}/sh/e2e/lib/teardown.sh" \
  "${REPO_ROOT}/sh/e2e/lib/soak.sh" \
  "${REPO_ROOT}/sh/e2e/lib/interactive.sh" \
  "${REPO_ROOT}/sh/e2e/lib/ai-review.sh" \
  "${REPO_ROOT}/sh/e2e/lib/clouds/aws.sh" \
  "${REPO_ROOT}/sh/e2e/lib/clouds/digitalocean.sh" \
  "${REPO_ROOT}/sh/e2e/lib/clouds/gcp.sh" \
  "${REPO_ROOT}/sh/e2e/lib/clouds/hetzner.sh" \
  "${REPO_ROOT}/sh/e2e/lib/clouds/sprite.sh"; do

  script_name=$(basename "${script}")
  if bash -n "${script}" 2>/dev/null; then
    _TESTS_RUN=$((_TESTS_RUN + 1))
    _TESTS_PASSED=$((_TESTS_PASSED + 1))
  else
    _TESTS_RUN=$((_TESTS_RUN + 1))
    _TESTS_FAILED=$((_TESTS_FAILED + 1))
    _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: bash -n ${script_name}"
  fi
done


# ===================================================================
# macOS compat linter on E2E scripts
# ===================================================================
printf '%b\n' "${BOLD}Testing: macOS compat linter on E2E scripts${NC}"

compat_script="${REPO_ROOT}/sh/test/macos-compat.sh"
if [ -f "${compat_script}" ]; then
  for script in \
    "${REPO_ROOT}/sh/e2e/lib/common.sh" \
    "${REPO_ROOT}/sh/e2e/lib/provision.sh" \
    "${REPO_ROOT}/sh/e2e/lib/verify.sh" \
    "${REPO_ROOT}/sh/e2e/lib/teardown.sh"; do

    script_name=$(basename "${script}")
    if bash "${compat_script}" "${script}" >/dev/null 2>&1; then
      _TESTS_RUN=$((_TESTS_RUN + 1))
      _TESTS_PASSED=$((_TESTS_PASSED + 1))
    else
      _TESTS_RUN=$((_TESTS_RUN + 1))
      _TESTS_FAILED=$((_TESTS_FAILED + 1))
      _FAIL_DETAILS="${_FAIL_DETAILS}\n  FAIL: macOS compat ${script_name}"
    fi
  done
fi


# ===================================================================
# Results
# ===================================================================
printf '\n%b================================%b\n' "${BOLD}" "${NC}"
if [ "${_TESTS_FAILED}" -eq 0 ]; then
  printf '%b%d/%d tests passed%b\n' "${GREEN}" "${_TESTS_PASSED}" "${_TESTS_RUN}" "${NC}"
else
  printf '%b%d/%d tests passed, %d failed%b\n' "${RED}" "${_TESTS_PASSED}" "${_TESTS_RUN}" "${_TESTS_FAILED}" "${NC}"
  printf '%b%b%b\n' "${RED}" "${_FAIL_DETAILS}" "${NC}"
fi
printf '%b================================%b\n' "${BOLD}" "${NC}"

if [ "${_TESTS_FAILED}" -gt 0 ]; then
  exit 1
fi
exit 0
