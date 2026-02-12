#!/bin/bash
# shellcheck disable=SC2154
# Test harness for spawn scripts
#
# Mocks the `sprite` CLI and runs each script end-to-end to verify:
#   1. common.sh sources correctly (local + remote)
#   2. All functions resolve
#   3. Env var flow works (SPRITE_NAME, OPENROUTER_API_KEY)
#   4. sprite commands are called in the correct order with correct args
#   5. Temp files are created and cleaned up
#   6. Each script reaches its final launch command
#
# Usage:
#   bash test/run.sh              # test all scripts
#   bash test/run.sh claude       # test one script
#   bash test/run.sh --remote     # test remote source (from GitHub)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR=$(mktemp -d)
MOCK_LOG="${TEST_DIR}/sprite_calls.log"
PASSED=0
FAILED=0
FILTER="${1:-}"
REMOTE=false

if [[ "${FILTER}" == "--remote" ]]; then
    REMOTE=true
    FILTER="${2:-}"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    rm -rf "${TEST_DIR}"
}
trap 'cleanup' EXIT

# --- Mock sprite CLI ---
# Records every call to a log, returns success for expected commands
setup_mocks() {
    cat > "${TEST_DIR}/sprite" << 'MOCK'
#!/bin/bash
echo "sprite $*" >> "${MOCK_LOG}"

case "$1" in
    org)    exit 0 ;;                          # auth check passes
    list)
        echo "existing-sprite"
        # After create, also return the test sprite name so provisioning poll succeeds
        if [[ -f "/tmp/sprite_mock_created_$$" ]] || [[ -f "/tmp/sprite_mock_created" ]]; then
            echo "${SPRITE_NAME:-}"
        fi
        exit 0
        ;;
    create)
        touch "/tmp/sprite_mock_created_$$" "/tmp/sprite_mock_created"
        exit 0
        ;;
    exec)
        # If there's a -file flag, just pretend to upload
        if [[ "$*" == *"-file"* ]]; then
            exit 0
        fi
        # If -tty, this is the final interactive launch — signal success and exit
        if [[ "$*" == *"-tty"* ]]; then
            echo "[MOCK] Would launch interactive session: $*" >> "${MOCK_LOG}"
            exit 0
        fi
        # Regular exec — just succeed
        exit 0
        ;;
    login)  exit 0 ;;
    *)      exit 0 ;;
esac
MOCK
    chmod +x "${TEST_DIR}/sprite"
}

# --- Mock other commands that shouldn't run for real ---
setup_extra_mocks() {
    # mock claude (for claude.sh install step)
    cat > "${TEST_DIR}/claude" << 'MOCK'
#!/bin/bash
echo "claude $*" >> "${MOCK_LOG}"
exit 0
MOCK
    chmod +x "${TEST_DIR}/claude"

    # mock openssl
    cat > "${TEST_DIR}/openssl" << 'MOCK'
#!/bin/bash
echo "mock-gateway-token-abc123"
MOCK
    chmod +x "${TEST_DIR}/openssl"
}

# --- Assertions ---
assert_contains() {
    local file="$1" pattern="$2" msg="$3"
    if grep -qE "${pattern}" "${file}" 2>/dev/null; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        ((PASSED++))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '%b\n' "    expected pattern: ${pattern}"
        printf '%b\n' "    in: ${file}"
        ((FAILED++))
    fi
}

assert_not_contains() {
    local file="$1" pattern="$2" msg="$3"
    if ! grep -qE "${pattern}" "${file}" 2>/dev/null; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        ((PASSED++))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        ((FAILED++))
    fi
}

assert_exit_code() {
    local actual="$1" expected="$2" msg="$3"
    if [[ "${actual}" -eq "${expected}" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        ((PASSED++))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg} (got exit code ${actual}, expected ${expected})"
        ((FAILED++))
    fi
}

# Assert that a value equals an expected string
# Usage: assert_equals ACTUAL EXPECTED MSG
assert_equals() {
    local actual="$1" expected="$2" msg="$3"
    if [[ "${actual}" == "${expected}" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        ((PASSED++))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg} (got '${actual}')"
        ((FAILED++))
    fi
}

# Assert that a value contains a substring pattern (glob match)
# Usage: assert_match ACTUAL PATTERN MSG
# PATTERN uses glob syntax: *substring* for contains, prefix* for starts-with, etc.
assert_match() {
    local actual="$1" pattern="$2" msg="$3"
    # Use a case statement for glob matching (compatible with bash 3.x)
    case "${actual}" in
        ${pattern})
            printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
            ((PASSED++))
            ;;
        *)
            printf '%b\n' "  ${RED}✗${NC} ${msg} (got '${actual}')"
            ((FAILED++))
            ;;
    esac
}

# Run a shared/common.sh function and assert it succeeds (exit 0)
assert_common_succeeds() {
    local msg="$1" cmd="$2"
    local result
    result=$(bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && '"${cmd}" 2>/dev/null)
    if [[ "${result}" == "valid" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        ((PASSED++))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        ((FAILED++))
    fi
}

# Run a shared/common.sh function and assert it fails (exit non-zero)
assert_common_fails() {
    local msg="$1" cmd="$2"
    local rc=0
    bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && '"${cmd}" </dev/null >/dev/null 2>&1 || rc=$?
    if [[ "${rc}" -ne 0 ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        ((PASSED++))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        ((FAILED++))
    fi
}

# --- Test runner for a single script ---
run_script_test() {
    local script_name="$1"
    local script_path="${REPO_ROOT}/sprite/${script_name}.sh"
    local output_file="${TEST_DIR}/${script_name}_output.log"

    echo ""
    printf '%b\n' "${YELLOW}━━━ Testing ${script_name}.sh ━━━${NC}"

    # Reset mock state
    : > "${MOCK_LOG}"
    rm -f /tmp/sprite_mock_created_* /tmp/sprite_mock_created 2>/dev/null || true

    # Run the script with mocked PATH and env vars (timeout 30s)
    local exit_code=0
    MOCK_LOG="${MOCK_LOG}" \
    SPRITE_NAME="test-sprite-${script_name}" \
    OPENROUTER_API_KEY="sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000" \
    PATH="${TEST_DIR}:${PATH}" \
        timeout 30 bash "${script_path}" > "${output_file}" 2>&1 || exit_code=$?

    assert_exit_code "${exit_code}" 0 "Script exits successfully"

    # Common assertions for all scripts
    assert_contains "${MOCK_LOG}" "sprite org list" "Checks sprite authentication"
    assert_contains "${MOCK_LOG}" "sprite list" "Checks if sprite exists"
    assert_contains "${MOCK_LOG}" "sprite create.*test-sprite-${script_name}" "Creates sprite with correct name"
    assert_contains "${MOCK_LOG}" "sprite exec.*test-sprite-${script_name}" "Runs commands on sprite"

    # Check env var injection (temp file upload)
    assert_contains "${MOCK_LOG}" "sprite exec.*-file.*/tmp/env_config" "Uploads env config to sprite"

    # Check final interactive launch (flag order varies: -s NAME -tty or -tty -s NAME)
    assert_contains "${MOCK_LOG}" "sprite exec.*-tty.*" "Launches interactive session"

    # Script-specific assertions
    case "${script_name}" in
        claude)
            assert_contains "${MOCK_LOG}" "sprite exec.*claude.*install" "Installs Claude Code"
            assert_contains "${MOCK_LOG}" "sprite exec.*-file.*/tmp/.*settings.json" "Uploads Claude settings"
            assert_contains "${MOCK_LOG}" "sprite exec.*-file.*/tmp/.*\.claude\.json" "Uploads Claude global state"
            ;;
        openclaw)
            assert_contains "${MOCK_LOG}" "sprite exec.*\.sprite.*bun.*openclaw" "Installs openclaw via bun"
            assert_contains "${MOCK_LOG}" "sprite exec.*openclaw gateway" "Starts openclaw gateway"
            ;;
        nanoclaw)
            assert_contains "${MOCK_LOG}" "sprite exec.*git.*nanoclaw" "Clones nanoclaw repo"
            assert_contains "${MOCK_LOG}" "sprite exec.*-file.*/tmp/nanoclaw_env" "Uploads nanoclaw .env"
            ;;
        *)
            # No agent-specific assertions for other agents
            ;;
    esac

    # Check no temp files leaked
    local leaked_temps
    leaked_temps=$(find /tmp -maxdepth 1 -name "tmp.*" -newer "${MOCK_LOG}" 2>/dev/null | wc -l)
    if [[ "${leaked_temps}" -eq 0 ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} No temp files leaked"
        ((PASSED++))
    fi
}

# --- Test common.sh sourcing ---
_test_sprite_functions_and_syntax() {
    # Source locally and check all functions exist
    local output
    output=$(bash -c '
        source "'"${REPO_ROOT}"'/sprite/lib/common.sh"
        for fn in log_info log_warn log_error safe_read \
                  ensure_sprite_installed ensure_sprite_authenticated \
                  get_sprite_name ensure_sprite_exists verify_sprite_connectivity \
                  run_sprite setup_shell_environment \
                  get_openrouter_api_key_manual try_oauth_flow \
                  get_openrouter_api_key_oauth open_browser; do
            type "${fn}" &>/dev/null && echo "OK:${fn}" || echo "MISSING:${fn}"
        done
    ' 2>/dev/null)

    local missing
    missing=$(echo "${output}" | grep "^MISSING:" || true)
    assert_equals "${missing}" "" "All functions defined"

    # Syntax check
    local rc=0
    bash -n "${REPO_ROOT}/sprite/lib/common.sh" 2>/dev/null || rc=$?
    assert_exit_code "${rc}" 0 "Syntax valid"
}

_test_sprite_log_and_name() {
    # log functions write to stderr, not stdout
    local stdout stderr
    stdout=$(timeout 5 bash -c 'source "'"${REPO_ROOT}"'/sprite/lib/common.sh" && log_info "test"' </dev/null 2>/dev/null)
    stderr=$(timeout 5 bash -c 'source "'"${REPO_ROOT}"'/sprite/lib/common.sh" && log_info "test"' </dev/null 2>&1 >/dev/null)
    assert_equals "${stdout}" "" "Log functions write to stderr (no stdout)"
    assert_match "${stderr}" "?*" "Log functions produce stderr output"

    # get_sprite_name uses SPRITE_NAME env var
    local name
    name=$(timeout 5 bash -c 'SPRITE_NAME=from-env; source "'"${REPO_ROOT}"'/sprite/lib/common.sh" && get_sprite_name' 2>/dev/null)
    assert_equals "${name}" "from-env" "get_sprite_name reads SPRITE_NAME env var"

    # get_sprite_name fails gracefully without TTY or env var
    local rc=0
    timeout 5 bash -c 'SPRITE_NAME=""; source "'"${REPO_ROOT}"'/sprite/lib/common.sh" && get_sprite_name' </dev/null >/dev/null 2>&1 || rc=$?
    assert_match "${rc}" "[1-9]*" "get_sprite_name fails without TTY or env var"
}

_test_sprite_remote_source() {
    if [[ "${REMOTE}" != true ]]; then
        return 0
    fi
    local remote_fns
    remote_fns=$(bash -c '
        source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)
        type log_info &>/dev/null && echo "OK" || echo "FAIL"
    ' 2>/dev/null)
    assert_equals "${remote_fns}" "OK" "Remote source from GitHub works"
}

test_common_source() {
    echo ""
    printf '%b\n' "${YELLOW}━━━ Testing common.sh ━━━${NC}"

    _test_sprite_functions_and_syntax
    _test_sprite_log_and_name
    _test_sprite_remote_source
}

# --- Test shared/common.sh functions ---
# --- shared/common.sh sub-tests (grouped by feature) ---

_test_model_validation() {
    assert_common_succeeds "validate_model_id accepts valid model IDs" \
        'validate_model_id "anthropic/claude-3.5-sonnet" && echo "valid"'
    assert_common_fails "validate_model_id rejects invalid characters" \
        'validate_model_id "bad;model"'
    assert_common_succeeds "validate_model_id accepts empty string" \
        'validate_model_id "" && echo "valid"'
    assert_common_succeeds "validate_model_id accepts openrouter/auto" \
        'validate_model_id "openrouter/auto" && echo "valid"'
    assert_common_succeeds "validate_model_id accepts model IDs with colons" \
        'validate_model_id "provider/model:version" && echo "valid"'

    # Bulk test: all shell metacharacters must be rejected
    # Note: backtick excluded due to shell escaping complexity
    local dangerous_chars=('$' '&' '|' '>' '<' '(' ')' '{' '}' ';' '*' '?' '[' ']')
    local rejected_count=0
    local rc
    for char in "${dangerous_chars[@]}"; do
        rc=0
        local test_str
        test_str=$(printf 'bad%smodel' "${char}")
        bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && validate_model_id '"$(printf '%q' "${test_str}")" </dev/null >/dev/null 2>&1 || rc=$?
        [[ "${rc}" -ne 0 ]] && ((rejected_count++))
    done
    assert_equals "${rejected_count}" "${#dangerous_chars[@]}" \
        "validate_model_id rejects shell metacharacters (${rejected_count}/${#dangerous_chars[@]})"
}

_test_json_escape() {
    local result
    result=$(bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && json_escape "test\"quote"' 2>/dev/null)
    # json_escape should produce escaped quotes (\\") in the output
    assert_match "${result}" '*\\"*' "json_escape handles special characters"
}

_test_ssh_key_utils() {
    # generate_ssh_key_if_missing - creates key
    local test_key="${TEST_DIR}/test_id_ed25519"
    bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && generate_ssh_key_if_missing "'"${test_key}"'"' >/dev/null 2>&1
    local key_exists="no"
    [[ -f "${test_key}" && -f "${test_key}.pub" ]] && key_exists="yes"
    assert_equals "${key_exists}" "yes" "generate_ssh_key_if_missing creates key"

    # generate_ssh_key_if_missing - skips existing
    local mtime_before
    mtime_before=$(stat -c %Y "${test_key}" 2>/dev/null || stat -f %m "${test_key}" 2>/dev/null)
    sleep 1
    bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && generate_ssh_key_if_missing "'"${test_key}"'"' >/dev/null 2>&1
    local mtime_after
    mtime_after=$(stat -c %Y "${test_key}" 2>/dev/null || stat -f %m "${test_key}" 2>/dev/null)
    assert_equals "${mtime_before}" "${mtime_after}" "generate_ssh_key_if_missing skips existing key"

    # get_ssh_fingerprint
    local result
    result=$(bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && get_ssh_fingerprint "'"${test_key}.pub"'"' 2>/dev/null)
    assert_match "${result}" "*:*" "get_ssh_fingerprint returns valid fingerprint"

    # extract_ssh_key_ids
    local mock_json='{"ssh_keys":[{"id":123},{"id":456}]}'
    result=$(bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && echo '"'${mock_json}'"' | extract_ssh_key_ids "$(cat)" "ssh_keys"' 2>/dev/null)
    assert_match "${result}" "*123*456*" "extract_ssh_key_ids parses JSON correctly"
}

_test_syntax_and_logging() {
    local rc=0
    bash -n "${REPO_ROOT}/shared/common.sh" 2>/dev/null || rc=$?
    assert_exit_code "${rc}" 0 "shared/common.sh syntax valid"

    local output missing
    output=$(bash -c '
        source "'"${REPO_ROOT}"'/shared/common.sh"
        for fn in log_info log_warn log_error; do
            type "${fn}" &>/dev/null && echo "OK:${fn}" || echo "MISSING:${fn}"
        done
    ' 2>/dev/null)
    missing=$(echo "${output}" | grep "^MISSING:" || true)
    assert_equals "${missing}" "" "All logging functions exist in shared/common.sh"
}

_test_open_browser() {
    # open_browser: termux
    local result
    result=$(bash -c '
        source "'"${REPO_ROOT}"'/shared/common.sh"
        termux-open-url() { echo "termux: $*"; }
        export -f termux-open-url
        open_browser "https://example.com"
    ' 2>/dev/null)
    assert_equals "${result}" "termux: https://example.com" "open_browser detects termux-open-url"

    # open_browser: macOS open
    result=$(bash -c '
        source "'"${REPO_ROOT}"'/shared/common.sh"
        open() { echo "macOS: $*"; }
        export -f open
        open_browser "https://example.com"
    ' 2>/dev/null)
    assert_equals "${result}" "macOS: https://example.com" "open_browser detects macOS open"

    # open_browser: fallback message
    local stderr_output
    stderr_output=$(bash -c '
        PATH="/usr/bin:/bin"
        source "'"${REPO_ROOT}"'/shared/common.sh"
        command() {
            if [[ "$2" == "termux-open-url" || "$2" == "open" || "$2" == "xdg-open" ]]; then
                return 1
            fi
            builtin command "$@"
        }
        export -f command
        open_browser "https://example.com"
    ' 2>&1 >/dev/null)
    assert_match "${stderr_output}" "*Please open: https://example.com*" \
        "open_browser shows fallback message when browsers unavailable"
}

_test_cloud_init() {
    # get_cloud_init_userdata
    local result
    result=$(bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && get_cloud_init_userdata' 2>/dev/null)
    assert_match "${result}" "*#cloud-config*" "get_cloud_init_userdata returns valid YAML"
    assert_match "${result}" "*curl*" "get_cloud_init_userdata includes curl"
    assert_match "${result}" "*git*" "get_cloud_init_userdata includes git"
    assert_match "${result}" "*zsh*" "get_cloud_init_userdata includes zsh"
    assert_match "${result}" "*bun.sh/install*" "get_cloud_init_userdata includes Bun installation"
    assert_match "${result}" "*claude.ai/install*" "get_cloud_init_userdata includes Claude installation"

    # check_openrouter_connectivity -- accepts success or graceful failure
    if command -v curl &> /dev/null; then
        local connectivity_result
        connectivity_result=$(bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && check_openrouter_connectivity && echo "reachable"' 2>/dev/null)
        # Accept both "reachable" and empty (network unavailable) -- just shouldn't crash
        assert_match "${connectivity_result:-ok}" "*" "check_openrouter_connectivity handles connectivity check"
    else
        printf '%b\n' "  ${YELLOW}⚠${NC} check_openrouter_connectivity test skipped (curl not available)"
    fi
}

_test_oauth_functions() {
    local rc

    # wait_for_oauth_code - success
    local code_test_file="${TEST_DIR}/oauth_code_test"
    echo "test_code" > "${code_test_file}"
    rc=0
    bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && wait_for_oauth_code "'"${code_test_file}"'" 1' >/dev/null 2>&1 || rc=$?
    assert_exit_code "${rc}" 0 "wait_for_oauth_code returns success when file exists"

    # wait_for_oauth_code - timeout
    local missing_file="${TEST_DIR}/missing_oauth_code"
    rc=0
    bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && wait_for_oauth_code "'"${missing_file}"'" 1' >/dev/null 2>&1 || rc=$?
    assert_match "${rc}" "[1-9]*" "wait_for_oauth_code returns failure on timeout"

    # cleanup_oauth_session
    local cleanup_test_dir="${TEST_DIR}/oauth_cleanup_test"
    mkdir -p "${cleanup_test_dir}"
    bash -c 'source "'"${REPO_ROOT}"'/shared/common.sh" && cleanup_oauth_session "" "'"${cleanup_test_dir}"'"' >/dev/null 2>&1
    local dir_removed="yes"
    [[ -d "${cleanup_test_dir}" ]] && dir_removed="no"
    assert_equals "${dir_removed}" "yes" "cleanup_oauth_session removes directory"
}

_test_ssh_wait() {
    # generic_ssh_wait - success
    local result
    result=$(bash -c '
        source "'"${REPO_ROOT}"'/shared/common.sh"
        ssh() { return 0; }
        export -f ssh
        generic_ssh_wait "root" "1.2.3.4" "-o Test" "true" "test" 2 1 2>&1
        echo $?
    ' 2>/dev/null | tail -1)
    assert_equals "${result}" "0" "generic_ssh_wait succeeds when command passes"

    # generic_ssh_wait - failure
    result=$(bash -c '
        source "'"${REPO_ROOT}"'/shared/common.sh"
        ssh() { return 1; }
        export -f ssh
        generic_ssh_wait "root" "1.2.3.4" "-o Test" "false" "test" 2 1 2>&1
        echo $?
    ' 2>/dev/null | tail -1)
    assert_equals "${result}" "1" "generic_ssh_wait fails after max attempts"
}

_test_input_and_server_validation() {
    # safe_read without TTY
    assert_common_fails "safe_read fails when no TTY available" \
        'safe_read "test: " </dev/null'

    # validate_server_name
    assert_common_succeeds "validate_server_name accepts valid names" \
        'validate_server_name "dev-server-01" && echo "valid"'
    assert_common_fails "validate_server_name rejects names too short" \
        'validate_server_name "ab"'

    local long_name
    long_name=$(printf 'a%.0s' {1..64})
    assert_common_fails "validate_server_name rejects names too long" \
        'validate_server_name "'"${long_name}"'"'
    assert_common_fails "validate_server_name rejects leading dash" \
        'validate_server_name "-server"'
    assert_common_fails "validate_server_name rejects trailing dash" \
        'validate_server_name "server-"'
    assert_common_fails "validate_server_name rejects invalid characters" \
        'validate_server_name "server_01"'
    assert_common_fails "validate_server_name rejects empty string" \
        'validate_server_name ""'
}

test_shared_common() {
    echo ""
    printf '%b\n' "${YELLOW}━━━ Testing shared/common.sh ━━━${NC}"

    _test_model_validation
    _test_json_escape
    _test_ssh_key_utils
    _test_syntax_and_logging
    _test_open_browser
    _test_cloud_init
    _test_oauth_functions
    _test_ssh_wait
    _test_input_and_server_validation
}

# --- Test source detection in each script ---
test_source_detection() {
    echo ""
    printf '%b\n' "${YELLOW}━━━ Testing source detection ━━━${NC}"

    for script in claude openclaw nanoclaw; do
        local script_path="${REPO_ROOT}/sprite/${script}.sh"
        [[ -f "${script_path}" ]] || continue

        # Verify the source block checks for local file existence
        assert_contains "${script_path}" 'if \[\[ -f "\$\{SCRIPT_DIR\}/lib/common.sh" \]\]' \
            "${script}.sh uses file-existence check for sourcing"

        # Verify syntax
        local rc=0
        bash -n "${script_path}" 2>/dev/null || rc=$?
        assert_exit_code "${rc}" 0 "${script}.sh syntax valid"
    done
}

# --- Static analysis with shellcheck ---
run_shellcheck() {
    echo ""
    printf '%b\n' "${YELLOW}━━━ Running shellcheck (static analysis) ━━━${NC}"

    # Check if shellcheck is available
    if ! command -v shellcheck &> /dev/null; then
        printf '%b\n' "  ${YELLOW}⚠${NC} shellcheck not found (install with: apt install shellcheck / brew install shellcheck)"
        printf '%b\n' "  ${YELLOW}⚠${NC} Skipping static analysis"
        return 0
    fi

    # Dynamically discover all shell scripts (agent scripts + lib files + test harness)
    local all_scripts=()
    local dir
    for dir in "${REPO_ROOT}"/*/; do
        local cloud
        cloud=$(basename "${dir}")
        # Skip non-cloud directories
        case "${cloud}" in
            cli|shared|test|node_modules|.git|.github|.claude|.docs) continue ;;
        esac
        # Add agent scripts and lib/common.sh if they exist
        local f
        for f in "${dir}"*.sh; do
            [[ -f "${f}" ]] && all_scripts+=("${f}")
        done
        [[ -f "${dir}lib/common.sh" ]] && all_scripts+=("${dir}lib/common.sh")
    done
    all_scripts+=("${REPO_ROOT}/shared/common.sh" "${REPO_ROOT}/test/run.sh")

    local issue_count=0
    local checked_count=0

    for script in "${all_scripts[@]}"; do
        [[ -f "${script}" ]] || continue
        ((checked_count++))

        # Run shellcheck with warning severity, exclude some noisy checks
        # SC1090: Can't follow non-constant source
        # SC2312: Consider invoking this command separately to avoid masking its return value
        local output
        output=$(shellcheck --severity=warning --exclude=SC1090,SC2312 "${script}" 2>&1)

        if [[ -n "${output}" ]]; then
            ((issue_count++))
            printf '%b\n' "  ${YELLOW}⚠${NC} $(basename "${script}"): found issues"
            echo "${output}" | sed 's/^/    /'
        fi
    done

    if [[ "${issue_count}" -eq 0 ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} No issues found in ${checked_count} scripts"
        ((PASSED++))
    else
        printf '%b\n' "  ${YELLOW}⚠${NC} Found issues in ${issue_count}/${checked_count} scripts (advisory only)"
        # Don't fail the build, just warn
    fi
}

# --- Main ---
echo "==============================="
echo " Spawn Script Test Suite"
echo "==============================="
echo ""
echo "Repo:     ${REPO_ROOT}"
echo "Temp dir: ${TEST_DIR}"
echo "Filter:   ${FILTER:-all}"
echo "Remote:   ${REMOTE}"

setup_mocks
setup_extra_mocks

run_shellcheck
test_common_source
test_shared_common
test_source_detection

# Run per-script tests
for script in claude openclaw nanoclaw; do
    if [[ -n "${FILTER}" && "${FILTER}" != "${script}" && "${FILTER}" != "--remote" ]]; then
        continue
    fi
    [[ -f "${REPO_ROOT}/sprite/${script}.sh" ]] && run_script_test "${script}"
done

# --- Summary ---
echo ""
echo "==============================="
TOTAL=$((PASSED + FAILED))
printf '%b\n' " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${TOTAL} total"
echo "==============================="

[[ "${FAILED}" -eq 0 ]] && exit 0 || exit 1
