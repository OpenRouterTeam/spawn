#!/bin/bash
# Fixture-based mock test suite for cloud provider agent scripts
#
# Uses recorded API responses from test/fixtures/{cloud}/ to test
# every agent script without making real API calls.
#
# Usage:
#   bash test/mock.sh                    # Test all clouds with fixtures
#   bash test/mock.sh hetzner            # Test all agents on one cloud
#   bash test/mock.sh hetzner claude     # Test one agent on one cloud

set -eo pipefail

if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
    printf 'WARNING: bash %s detected. Some features may need bash 4+.\n' "${BASH_VERSION}" >&2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="${REPO_ROOT}/test/fixtures"
TEST_DIR=$(mktemp -d)
MOCK_LOG="${TEST_DIR}/mock_calls.log"

# Colors (respect NO_COLOR standard: https://no-color.org/)
if [[ -n "${NO_COLOR:-}" ]]; then
    RED='' GREEN='' YELLOW='' CYAN='' NC=''
else
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    NC='\033[0m'
fi

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Cleanup on exit
cleanup() {
    rm -rf "${TEST_DIR}"
}
trap cleanup EXIT

# ============================================================
# Assertions (same pattern as test/run.sh)
# ============================================================

assert_exit_code() {
    local actual="$1"
    local expected="$2"
    local msg="$3"
    if [[ "${actual}" -eq "${expected}" ]]; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg} (got exit code ${actual})"
        FAILED=$((FAILED + 1))
    fi
}

assert_log_contains() {
    local pattern="$1"
    local msg="$2"
    if grep -qE "${pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_api_called() {
    local method="$1"
    local endpoint_pattern="$2"
    local msg="${3:-calls ${method} ${endpoint_pattern}}"
    if grep -qE "curl ${method} .*${endpoint_pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_env_injected() {
    local var_name="$1"
    local msg="${2:-injects ${var_name}}"
    # Check mock log (ssh/scp commands may reference the var) and output log.
    # Also check case-insensitively: OPENROUTER_API_KEY → "openrouter" appears
    # in output like "Using OpenRouter API key from environment".
    local first_word
    first_word=$(printf '%s' "$var_name" | sed 's/_.*//' | tr '[:upper:]' '[:lower:]')
    if grep -qE "${var_name}" "${MOCK_LOG}" 2>/dev/null || \
       grep -qE "${var_name}" "${TEST_DIR}/output.log" 2>/dev/null || \
       grep -qi "${first_word}" "${TEST_DIR}/output.log" 2>/dev/null || \
       grep -qi "${first_word}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_file_created() {
    local path_pattern="$1"
    local msg="${2:-creates file matching ${path_pattern}}"
    if grep -qE "(scp|upload|file).*${path_pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_no_body_errors() {
    local msg="${1:-no request body validation errors}"
    if grep -qE "BODY_ERROR:" "${MOCK_LOG}" 2>/dev/null; then
        local errors
        errors=$(grep "BODY_ERROR:" "${MOCK_LOG}" 2>/dev/null)
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        printf '%b\n' "    ${RED}  Errors:${NC}"
        printf '%s\n' "$errors" | while IFS= read -r line; do
            printf '      %s\n' "$line"
        done
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    fi
}

assert_server_cleaned_up() {
    local state_file="$1"
    local msg="${2:-server lifecycle tracked}"
    if [[ ! -f "$state_file" ]]; then
        printf '%b\n' "    ${YELLOW}⚠${NC} ${msg} (no state file)"
        return 0
    fi
    local created deleted
    created=$(grep -c "^CREATED:" "$state_file" 2>/dev/null || true)
    deleted=$(grep -c "^DELETED:" "$state_file" 2>/dev/null || true)
    if [[ "$created" -gt 0 ]]; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg} (created=${created}, deleted=${deleted})"
        PASSED=$((PASSED + 1))
        if [[ "$deleted" -lt "$created" ]]; then
            printf '%b\n' "    ${YELLOW}⚠${NC} warning: ${created} created but only ${deleted} deleted (expected — user takes over)"
        fi
    else
        printf '%b\n' "    ${YELLOW}⚠${NC} ${msg} (no server creation tracked)"
    fi
}

# ============================================================
# Mock setup
# ============================================================

setup_mock_curl() {
    local SCRIPT_DIR
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cp "${SCRIPT_DIR}/mock-curl-script.sh" "${TEST_DIR}/curl"
    chmod +x "${TEST_DIR}/curl"
}

setup_mock_ssh() {
    # Mock ssh — log and succeed
    cat > "${TEST_DIR}/ssh" << 'MOCKSSH'
#!/bin/bash
echo "ssh $*" >> "${MOCK_LOG}"
exit 0
MOCKSSH
    chmod +x "${TEST_DIR}/ssh"

    # Mock scp — log and succeed
    cat > "${TEST_DIR}/scp" << 'MOCKSCP'
#!/bin/bash
echo "scp $*" >> "${MOCK_LOG}"
exit 0
MOCKSCP
    chmod +x "${TEST_DIR}/scp"
}

# Create a mock that logs its invocation and exits 0
# Usage: _create_logging_mock NAME [NAME...]
_create_logging_mock() {
    local name
    for name in "$@"; do
        cat > "${TEST_DIR}/${name}" << MOCK
#!/bin/bash
echo "${name} \$*" >> "\${MOCK_LOG}"
exit 0
MOCK
        chmod +x "${TEST_DIR}/${name}"
    done
}

# Create a mock that silently exits 0 (no logging)
# Usage: _create_silent_mock NAME [NAME...]
_create_silent_mock() {
    local name
    for name in "$@"; do
        cat > "${TEST_DIR}/${name}" << 'MOCK'
#!/bin/bash
exit 0
MOCK
        chmod +x "${TEST_DIR}/${name}"
    done
}

# Create the ssh-keygen mock script
_create_ssh_keygen_mock() {
    cat > "${TEST_DIR}/ssh-keygen" << 'MOCK'
#!/bin/bash
echo "ssh-keygen $*" >> "${MOCK_LOG}"
# Check for -l flag (fingerprint listing)
for arg in "$@"; do
    case "$arg" in
        -l*) echo "256 MD5:af:0d:c5:57:a8:fd:b2:82:5e:d4:c1:65:f0:0c:8a:9d test@test (ED25519)"; exit 0 ;;
    esac
done
# Parse -f flag for key creation
KEY_PATH=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-f" ]; then
        KEY_PATH="$arg"
    fi
    prev="$arg"
done
if [ -n "$KEY_PATH" ]; then
    mkdir -p "$(dirname "$KEY_PATH")"
    touch "$KEY_PATH"
    echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmcVdzydp72a/B69nmENZvCvjuk7xGpKdi5CvhkmNsv test@test" > "${KEY_PATH}.pub"
fi
exit 0
MOCK
    chmod +x "${TEST_DIR}/ssh-keygen"
}

setup_mock_agents() {
    # Agent binaries
    _create_logging_mock claude aider goose codex interpreter gemini amazonq cline gptme opencode plandex kilocode openclaw nanoclaw q

    # Tools used during agent install
    _create_logging_mock pip pip3 npm npx bun node openssl shred cargo go git

    # Silent mocks (no logging needed)
    _create_silent_mock clear sleep

    # Mock 'ssh-keygen' — returns MD5 fingerprint matching fixture data
    _create_ssh_keygen_mock
}

setup_fake_home() {
    local fake_home="${TEST_DIR}/fakehome"
    mkdir -p "${fake_home}/.ssh"
    mkdir -p "${fake_home}/.config/spawn"
    mkdir -p "${fake_home}/.claude"
    mkdir -p "${fake_home}/.local/bin"
    # Create dummy SSH key pair
    echo "-----BEGIN OPENSSH PRIVATE KEY-----" > "${fake_home}/.ssh/id_ed25519"
    echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmcVdzydp72a/B69nmENZvCvjuk7xGpKdi5CvhkmNsv test@test" > "${fake_home}/.ssh/id_ed25519.pub"
    chmod 600 "${fake_home}/.ssh/id_ed25519"
    echo "${fake_home}"
}

# ============================================================
# Cloud API helpers (for use by test infra tests)
# ============================================================

# Strip API base URL to get just the endpoint path.
# Used by test/test-infra-sync.test.ts to validate cloud coverage.
_strip_simple_base() {
    local url="$1" pattern="$2"
    echo "$url" | sed "s|${pattern}||"
}

_strip_pattern_base() {
    local url="$1" sed_pattern="$2"
    echo "$url" | sed "$sed_pattern"
}

_strip_gcore_endpoint() {
    local url="$1"
    case "$url" in
        https://api.gcore.com/cloud/v*/instances/*/*/*)
            echo "$url" | sed 's|.*/instances/[^/]*/[^/]*/|/instances/|' ;;
        https://api.gcore.com/cloud/v*/instances/*/*)
            echo "/instances" ;;
        https://api.gcore.com/cloud/v*/*/*/*/*)
            echo "$url" | sed 's|.*/cloud/v[0-9]*/\([^/]*\)/[^/]*/[^/]*/|/\1/|' ;;
        https://api.gcore.com/cloud/v*/*/*/*)
            echo "$url" | sed 's|.*/cloud/v[0-9]*/\([^/]*\)/[^/]*/[^/]*$|/\1|' ;;
        https://api.gcore.com/cloud/v*/*/*)
            echo "$url" | sed 's|.*/cloud/v[0-9]*/\([^/]*\)/[^/]*$|/\1|' ;;
        https://api.gcore.com/cloud/v*/*)
            echo "$url" | sed 's|.*/cloud/v[0-9]*/||; s|^|/|' ;;
        https://api.gcore.com*)
            echo "$url" | sed 's|https://api.gcore.com||' ;;
        *) echo "$url" ;;
    esac
}

_strip_scaleway_endpoint() {
    local url="$1"
    case "$url" in
        https://api.scaleway.com/instance/v1/zones/*)
            echo "$url" | sed 's|https://api.scaleway.com/instance/v1/zones/[^/]*/||' ;;
        https://api.scaleway.com/account/v3*)
            echo "$url" | sed 's|https://api.scaleway.com/account/v3||' ;;
        https://api.scaleway.com/*)
            echo "$url" | sed 's|https://api.scaleway.com/[^/]*/[^/]*/||' ;;
        *) echo "$url" ;;
    esac
}

_strip_api_base() {
    local url="$1"
    local endpoint="$url"

    case "$url" in
        https://api.hetzner.cloud/v1*)
            endpoint="${url#https://api.hetzner.cloud/v1}" ;;
        https://api.digitalocean.com/v2*)
            endpoint="${url#https://api.digitalocean.com/v2}" ;;
        https://api.vultr.com/v2*)
            endpoint="${url#https://api.vultr.com/v2}" ;;
        https://api.linode.com/v4*)
            endpoint="${url#https://api.linode.com/v4}" ;;
        https://cloud.lambdalabs.com/api/v1*)
            endpoint="${url#https://cloud.lambdalabs.com/api/v1}" ;;
        https://api.civo.com/v2*)
            endpoint="${url#https://api.civo.com/v2}" ;;
        https://api.upcloud.com/1.3*)
            endpoint="${url#https://api.upcloud.com/1.3}" ;;
        https://api.binarylane.com.au/v2*)
            endpoint="${url#https://api.binarylane.com.au/v2}" ;;
        https://api.scaleway.com/*)
            endpoint=$(_strip_scaleway_endpoint "$url") ;;
        https://api.genesiscloud.com/compute/v1*)
            endpoint="${url#https://api.genesiscloud.com/compute/v1}" ;;
        https://console.kamatera.com/svc*)
            endpoint="${url#https://console.kamatera.com/svc}" ;;
        https://api.latitude.sh*)
            endpoint="${url#https://api.latitude.sh}" ;;
        https://infrahub-api.nexgencloud.com/v1*)
            endpoint="${url#https://infrahub-api.nexgencloud.com/v1}" ;;
        *eu.api.ovh.com*)
            endpoint=$(echo "$url" | sed 's|https://eu.api.ovh.com/1.0||') ;;
        https://cloudapi.atlantic.net/*)
            endpoint=$(echo "$url" | sed 's|https://cloudapi.atlantic.net/\?||') ;;
        https://invapi.hostkey.com*)
            endpoint="${url#https://invapi.hostkey.com}" ;;
        https://*.cloudsigma.com/api/2.0*)
            endpoint=$(echo "$url" | sed 's|https://[^/]*.cloudsigma.com/api/2.0||') ;;
        https://api.webdock.io/v1*)
            endpoint="${url#https://api.webdock.io/v1}" ;;
        https://api.serverspace.io/api/v1*)
            endpoint="${url#https://api.serverspace.io/api/v1}" ;;
        https://api.gcore.com*)
            endpoint=$(_strip_gcore_endpoint "$url") ;;
    esac

    echo "$endpoint" | sed 's|?.*||'
}

# Get required POST body fields for a cloud endpoint.
_get_required_fields() {
    local cloud="$1"
    local endpoint="$2"

    case "${cloud}:${endpoint}" in
        hetzner:/servers) echo "name server_type image location" ;;
        digitalocean:/droplets) echo "name region size image" ;;
        vultr:/instances) echo "label region plan os_id" ;;
        linode:/linode/instances) echo "label region type image" ;;
        civo:/instances) echo "hostname size region" ;;
        binarylane:/servers) echo "name region plan os_id" ;;
        upcloud:/server) echo "server" ;;
        genesiscloud:/instances) echo "name" ;;
        hyperstack:/servers) echo "name" ;;
        kamatera:/server/create) echo "datacenter" ;;
        latitude:/servers) echo "hostname site_id os_type" ;;
        ovh:*/create) echo "name" ;;
        scaleway:/servers) echo "name" ;;
        webdock:/servers) echo "name slug locationId profileSlug imageSlug" ;;
        serverspace:/servers) echo "name location_id image_id cpu ram_mb" ;;
        gcore:/instances) echo "name flavor volumes interfaces" ;;
    esac
}

# Validate POST request body contains required fields for major clouds.
# Used during mock script execution to catch invalid API requests.
# Args: cloud method endpoint body
_validate_body() {
    local cloud="$1"
    local method="$2"
    local endpoint="$3"
    local body="$4"

    [[ "$method" != "POST" ]] && return 0
    [[ -z "$body" ]] && return 0

    local required_fields
    required_fields=$(_get_required_fields "$cloud" "$endpoint")
    [[ -z "$required_fields" ]] && return 0

    # Check if body is valid JSON
    if ! printf '%s' "$body" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
        echo "BODY_ERROR:invalid_json:${endpoint}" >> "${MOCK_LOG}"
        return 1
    fi

    # Check for required fields
    for field in $required_fields; do
        if ! printf '%s' "$body" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert '$field' in d" 2>/dev/null; then
            echo "BODY_ERROR:missing_field:${field}:${endpoint}" >> "${MOCK_LOG}"
        fi
    done

    return 0
}

# ============================================================
# Cloud-specific env var setup
# ============================================================

setup_env_for_cloud() {
    local cloud="$1"

    # Universal env vars
    export OPENROUTER_API_KEY="sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000"
    export INSTANCE_STATUS_POLL_DELAY=0

    # Cloud-specific env vars from fixture data
    local env_file="${FIXTURES_DIR}/${cloud}/_env.sh"
    if [[ -f "$env_file" ]]; then
        # shellcheck disable=SC1090
        source "$env_file"
    fi
}

# ============================================================
# Discovery
# ============================================================

discover_clouds() {
    for fixture_dir in "${FIXTURES_DIR}"/*/; do
        local cloud
        cloud=$(basename "$fixture_dir")
        if [[ -f "${fixture_dir}/_metadata.json" ]]; then
            echo "$cloud"
        fi
    done
}

discover_agents() {
    local cloud="$1"
    for script in "${REPO_ROOT}/${cloud}"/*.sh; do
        [[ -f "$script" ]] || continue
        local agent
        agent=$(basename "$script" .sh)
        echo "$agent"
    done
}

# ============================================================
# Test runner helpers
# ============================================================

# Wait for a process to complete or timeout
# Args: pid timeout_seconds exit_code_var
_wait_with_timeout() {
    local pid="$1"
    local timeout="$2"
    local exit_code_var="$3"
    local i=0

    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$i" -ge "$timeout" ]]; then
            kill -9 "$pid" 2>/dev/null
            wait "$pid" 2>/dev/null || true
            eval "${exit_code_var}=124"
            return
        fi
        sleep 1
        i=$((i + 1))
    done
    wait "$pid" 2>/dev/null || eval "${exit_code_var}=$?"
}

# Run a script in a sandboxed environment with a 4-second timeout.
# Sets exit_code variable in the caller's scope.
# Args: script_path cloud state_file fake_home
run_script_with_timeout() {
    local script_path="$1"
    local cloud="$2"
    local state_file="$3"
    local fake_home="$4"

    exit_code=0

    MOCK_LOG="${MOCK_LOG}" \
    MOCK_FIXTURE_DIR="${FIXTURES_DIR}/${cloud}" \
    MOCK_CLOUD="${cloud}" \
    MOCK_REPO_ROOT="${REPO_ROOT}" \
    MOCK_VALIDATE_BODY="${MOCK_VALIDATE_BODY:-}" \
    MOCK_TRACK_STATE="${MOCK_TRACK_STATE:-}" \
    MOCK_STATE_FILE="${state_file}" \
    MOCK_ERROR_SCENARIO="${MOCK_ERROR_SCENARIO:-}" \
    PATH="${TEST_DIR}:${PATH}" \
    HOME="${fake_home}" \
        bash "${script_path}" < /dev/null > "${TEST_DIR}/output.log" 2>&1 &
    local pid=$!
    _wait_with_timeout "$pid" 4 "exit_code"
}

# Print last 20 lines of output on script failure.
# Args: exit_code
show_failure_output() {
    local exit_code="$1"
    if [[ "${exit_code}" -ne 0 ]]; then
        printf '%b\n' "    ${RED}--- output (last 20 lines) ---${NC}"
        tail -20 "${TEST_DIR}/output.log" 2>/dev/null | while IFS= read -r line; do
            printf '    %s\n' "$line"
        done
        printf '%b\n' "    ${RED}--- end output ---${NC}"
    fi
}

# Assert that the script failed when an error scenario was injected.
# Returns 0 (with result recorded) if an error scenario is active, 1 otherwise.
# Args: exit_code cloud agent
assert_error_scenario() {
    local exit_code="$1"
    local cloud="$2"
    local agent="$3"

    [[ -n "${MOCK_ERROR_SCENARIO:-}" ]] || return 1

    if [[ "${exit_code}" -ne 0 ]]; then
        printf '%b\n' "    ${GREEN}✓${NC} fails on ${MOCK_ERROR_SCENARIO} (exit code ${exit_code})"
        PASSED=$((PASSED + 1))
        record_test_result "${cloud}" "${agent}" "pass"
    else
        printf '%b\n' "    ${RED}✗${NC} should fail on ${MOCK_ERROR_SCENARIO} but exited 0"
        FAILED=$((FAILED + 1))
        record_test_result "${cloud}" "${agent}" "fail"
    fi
    return 0
}

# Assert that the expected cloud-specific API calls were made.
# Reads assertions from test/fixtures/{cloud}/_api_assertions.sh if present,
# otherwise falls back to a generic API call check.
# Args: cloud
assert_cloud_api_calls() {
    local cloud="$1"
    local assertions_file="${FIXTURES_DIR}/${cloud}/_api_assertions.sh"
    if [[ -f "$assertions_file" ]]; then
        # shellcheck disable=SC1090
        source "$assertions_file"
    else
        assert_log_contains "curl (GET|POST) https://" "makes API calls"
    fi
}

# Write pass/fail result to RESULTS_FILE if set.
# Args: cloud agent result [reason]
# Result format: cloud/agent:pass or cloud/agent:fail[:reason]
# Reasons: exit_code, missing_api_call, missing_env, no_fixture
record_test_result() {
    local cloud="$1"
    local agent="$2"
    local result="$3"
    local reason="${4:-}"
    [[ -n "${RESULTS_FILE:-}" ]] || return 0
    if [[ -n "$reason" ]]; then
        printf '%s/%s:%s:%s\n' "${cloud}" "${agent}" "${result}" "${reason}" >> "${RESULTS_FILE}"
    else
        printf '%s/%s:%s\n' "${cloud}" "${agent}" "${result}" >> "${RESULTS_FILE}"
    fi
}

# ============================================================
# Test runner
# ============================================================

# Run an assertion and store the number of new failures in _ASSERT_DELTA.
# Usage: _tracked_assert <assertion_command> [args...]
# The assertion runs in the current shell so PASSED/FAILED propagate.
_tracked_assert() {
    local _before=$FAILED
    "$@"
    _ASSERT_DELTA=$(( FAILED - _before ))
}

# Determine the primary failure reason from tracked failure counts.
# Args: has_no_fixture exit_fails api_fails ssh_fails env_fails
# Prints the reason string to stdout.
_categorize_failure() {
    local has_no_fixture="$1" exit_fails="$2" api_fails="$3" ssh_fails="$4" env_fails="$5"
    if [[ "$has_no_fixture" -gt 0 ]]; then echo "no_fixture"
    elif [[ "$exit_fails" -gt 0 ]]; then echo "exit_code"
    elif [[ "$api_fails" -gt 0 ]]; then echo "missing_api_call"
    elif [[ "$env_fails" -gt 0 ]]; then echo "missing_env"
    elif [[ "$ssh_fails" -gt 0 ]]; then echo "missing_ssh"
    else echo "unknown"
    fi
}

# Run assertions for a script and track which categories failed.
# Outputs: _exit_failed, _api_failed, _ssh_failed, _env_failed (as 0/1)
_run_assertions_and_track() {
    local exit_code="$1" cloud="$2"
    local _ASSERT_DELTA=0

    _tracked_assert assert_exit_code "${exit_code}" 0 "exits successfully"
    _exit_failed=$_ASSERT_DELTA

    _tracked_assert assert_cloud_api_calls "$cloud"
    _api_failed=$_ASSERT_DELTA

    _tracked_assert assert_log_contains "ssh " "uses SSH"
    _ssh_failed=$_ASSERT_DELTA

    _tracked_assert assert_env_injected "OPENROUTER_API_KEY"
    _env_failed=$_ASSERT_DELTA

    if [[ "${MOCK_VALIDATE_BODY:-}" == "1" ]]; then
        assert_no_body_errors
    fi
    if [[ "${MOCK_TRACK_STATE:-}" == "1" ]]; then
        assert_server_cleaned_up "$3"
    fi
}

# Check for missing fixtures in the mock log.
_has_missing_fixture() {
    grep -q "NO_FIXTURE:" "${MOCK_LOG}" 2>/dev/null && echo 1 || echo 0
}

# Setup test environment for a script
# Args: cloud state_file
_setup_test_env() {
    local cloud="$1"
    local state_file="$2"
    : > "${MOCK_LOG}"
    setup_env_for_cloud "$cloud"
    : > "${state_file}"
}

# Record test result based on failure categories
# Args: cloud agent pre_failed
_record_categorized_result() {
    local cloud="$1"
    local agent="$2"
    local pre_failed="$3"

    local pre_fail=$((FAILED - pre_failed))
    if [[ "$pre_fail" -gt 0 ]]; then
        local _has_no_fixture
        _has_no_fixture=$(_has_missing_fixture)
        local _reason
        _reason=$(_categorize_failure "$_has_no_fixture" "$_exit_failed" "$_api_failed" "$_ssh_failed" "$_env_failed")
        record_test_result "${cloud}" "${agent}" "fail" "${_reason}"
    else
        record_test_result "${cloud}" "${agent}" "pass"
    fi
}

run_test() {
    local cloud="$1"
    local agent="$2"
    local script_path="${REPO_ROOT}/${cloud}/${agent}.sh"

    if [[ ! -f "$script_path" ]]; then
        printf '%b\n' "  ${YELLOW}skip${NC} ${cloud}/${agent}.sh — file not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}test${NC} ${cloud}/${agent}.sh"

    local _pre_failed="${FAILED}"
    local fake_home
    fake_home=$(setup_fake_home)
    local state_file="${TEST_DIR}/state_${cloud}_${agent}.log"

    _setup_test_env "$cloud" "$state_file"

    local exit_code
    run_script_with_timeout "${script_path}" "${cloud}" "${state_file}" "${fake_home}"
    show_failure_output "${exit_code}"

    # Error scenario mode: just check that script failed, then return
    if assert_error_scenario "${exit_code}" "${cloud}" "${agent}"; then
        printf '\n'
        return 0
    fi

    # Normal mode: run standard assertions and track failures per category
    _run_assertions_and_track "${exit_code}" "${cloud}" "${state_file}"
    _record_categorized_result "${cloud}" "${agent}" "$_pre_failed"

    printf '\n'
}

# ============================================================
# Main
# ============================================================

printf '%b\n' "${CYAN}===============================${NC}"
printf '%b\n' "${CYAN} Spawn Mock Test Suite${NC}"
printf '%b\n' "${CYAN}===============================${NC}"
printf '\n'

# Parse arguments
FILTER_CLOUD="${1:-}"
FILTER_AGENT="${2:-}"

# Set up mocks once
setup_mock_curl
setup_mock_ssh
setup_mock_agents

# Discover what to test
if [[ -n "$FILTER_CLOUD" ]]; then
    CLOUDS="$FILTER_CLOUD"
    if [[ ! -d "${FIXTURES_DIR}/${FILTER_CLOUD}" ]]; then
        printf '%b\n' "${RED}No fixtures for cloud: ${FILTER_CLOUD}${NC}"
        printf "Available: %s\n" "$(discover_clouds | tr '\n' ' ')"
        exit 1
    fi
else
    CLOUDS=$(discover_clouds)
fi

if [[ -z "$CLOUDS" ]]; then
    printf '%b\n' "${YELLOW}No fixture data found in ${FIXTURES_DIR}/${NC}"
    printf "Run test/record.sh first to record API fixtures.\n"
    exit 0
fi

printf "Fixtures dir: %s\n" "${FIXTURES_DIR}"
printf "Clouds:       %s\n" "$CLOUDS"
printf '\n'

# --- Run clouds in parallel ---
CLOUD_RESULTS_DIR="${TEST_DIR}/cloud_results"
mkdir -p "${CLOUD_RESULTS_DIR}"

CLOUD_PIDS=""
for cloud in $CLOUDS; do
    (
        # Isolated per-cloud state
        CLOUD_TEST_DIR=$(mktemp -d)
        MOCK_LOG="${CLOUD_TEST_DIR}/mock_calls.log"
        CLOUD_PASSED=0
        CLOUD_FAILED=0
        CLOUD_SKIPPED=0

        # Re-create mocks in per-cloud temp dir (curl/ssh/agents need own copies)
        TEST_DIR="${CLOUD_TEST_DIR}"
        setup_mock_curl
        setup_mock_ssh
        setup_mock_agents

        # Override counters used by assertions (they modify PASSED/FAILED/SKIPPED)
        PASSED=0
        FAILED=0
        SKIPPED=0

        printf '%b\n' "${CYAN}━━━ ${cloud} ━━━${NC}"

        if [[ -n "$FILTER_AGENT" ]]; then
            AGENTS="$FILTER_AGENT"
        else
            AGENTS=$(discover_agents "$cloud")
        fi

        if [[ -z "$AGENTS" ]]; then
            printf '%b\n' "  ${YELLOW}skip${NC} no agent scripts found in ${cloud}/"
            SKIPPED=$((SKIPPED + 1))
        else
            for agent in $AGENTS; do
                run_test "$cloud" "$agent"
            done
        fi
        printf '\n'

        # Write counts to results file for aggregation
        printf '%d %d %d\n' "$PASSED" "$FAILED" "$SKIPPED" > "${CLOUD_RESULTS_DIR}/${cloud}.counts"

        rm -rf "${CLOUD_TEST_DIR}"
    ) > "${CLOUD_RESULTS_DIR}/${cloud}.log" 2>&1 &
    CLOUD_PIDS="${CLOUD_PIDS} $!"
done

# Wait for all clouds to finish
for pid in $CLOUD_PIDS; do
    wait "$pid" 2>/dev/null || true
done

# Print output from each cloud (in discovery order for consistent output)
for cloud in $CLOUDS; do
    if [[ -f "${CLOUD_RESULTS_DIR}/${cloud}.log" ]]; then
        cat "${CLOUD_RESULTS_DIR}/${cloud}.log"
    fi
done

# Aggregate results from all clouds
for cloud in $CLOUDS; do
    if [[ -f "${CLOUD_RESULTS_DIR}/${cloud}.counts" ]]; then
        read -r p f s < "${CLOUD_RESULTS_DIR}/${cloud}.counts"
        PASSED=$((PASSED + p))
        FAILED=$((FAILED + f))
        SKIPPED=$((SKIPPED + s))
    fi
done

# --- Summary ---
printf '%b\n' "${CYAN}===============================${NC}"
TOTAL=$((PASSED + FAILED + SKIPPED))
printf '%b\n' " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}, ${TOTAL} total"
printf '%b\n' "${CYAN}===============================${NC}"

if [[ "$FAILED" -gt 0 ]]; then
    exit 1
fi
exit 0
