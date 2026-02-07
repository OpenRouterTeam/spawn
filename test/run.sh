#!/bin/bash
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
MOCK_LOG="$TEST_DIR/sprite_calls.log"
PASSED=0
FAILED=0
FILTER="${1:-}"
REMOTE=false

if [[ "$FILTER" == "--remote" ]]; then
    REMOTE=true
    FILTER="${2:-}"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# --- Mock sprite CLI ---
# Records every call to a log, returns success for expected commands
setup_mocks() {
    cat > "$TEST_DIR/sprite" << 'MOCK'
#!/bin/bash
echo "sprite $*" >> "$MOCK_LOG"

case "$1" in
    org)    exit 0 ;;                          # auth check passes
    list)   echo "existing-sprite"; exit 0 ;;  # list returns no match for test sprite
    create) exit 0 ;;
    exec)
        # If there's a -file flag, just pretend to upload
        if [[ "$*" == *"-file"* ]]; then
            exit 0
        fi
        # If -tty, this is the final interactive launch — signal success and exit
        if [[ "$*" == *"-tty"* ]]; then
            echo "[MOCK] Would launch interactive session: $*" >> "$MOCK_LOG"
            exit 0
        fi
        # Regular exec — just succeed
        exit 0
        ;;
    login)  exit 0 ;;
    *)      exit 0 ;;
esac
MOCK
    chmod +x "$TEST_DIR/sprite"
}

# --- Mock other commands that shouldn't run for real ---
setup_extra_mocks() {
    # mock claude (for claude.sh install step)
    cat > "$TEST_DIR/claude" << 'MOCK'
#!/bin/bash
echo "claude $*" >> "$MOCK_LOG"
exit 0
MOCK
    chmod +x "$TEST_DIR/claude"

    # mock openssl
    cat > "$TEST_DIR/openssl" << 'MOCK'
#!/bin/bash
echo "mock-gateway-token-abc123"
MOCK
    chmod +x "$TEST_DIR/openssl"
}

# --- Assertions ---
assert_contains() {
    local file="$1" pattern="$2" msg="$3"
    if grep -qE "$pattern" "$file" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} $msg"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} $msg"
        echo -e "    expected pattern: $pattern"
        echo -e "    in: $file"
        ((FAILED++))
    fi
}

assert_not_contains() {
    local file="$1" pattern="$2" msg="$3"
    if ! grep -qE "$pattern" "$file" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} $msg"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} $msg"
        ((FAILED++))
    fi
}

assert_exit_code() {
    local actual="$1" expected="$2" msg="$3"
    if [[ "$actual" -eq "$expected" ]]; then
        echo -e "  ${GREEN}✓${NC} $msg"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} $msg (got exit code $actual, expected $expected)"
        ((FAILED++))
    fi
}

# --- Test runner for a single script ---
run_script_test() {
    local script_name="$1"
    local script_path="$REPO_ROOT/sprite/${script_name}.sh"
    local output_file="$TEST_DIR/${script_name}_output.log"

    echo ""
    echo -e "${YELLOW}━━━ Testing ${script_name}.sh ━━━${NC}"

    # Reset mock log
    > "$MOCK_LOG"

    # Run the script with mocked PATH and env vars (timeout 30s)
    local exit_code=0
    MOCK_LOG="$MOCK_LOG" \
    SPRITE_NAME="test-sprite-${script_name}" \
    OPENROUTER_API_KEY="sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000" \
    PATH="$TEST_DIR:$PATH" \
        timeout 30 bash "$script_path" > "$output_file" 2>&1 || exit_code=$?

    assert_exit_code "$exit_code" 0 "Script exits successfully"

    # Common assertions for all scripts
    assert_contains "$MOCK_LOG" "sprite org list" "Checks sprite authentication"
    assert_contains "$MOCK_LOG" "sprite list" "Checks if sprite exists"
    assert_contains "$MOCK_LOG" "sprite create.*test-sprite-${script_name}" "Creates sprite with correct name"
    assert_contains "$MOCK_LOG" "sprite exec.*test-sprite-${script_name}" "Runs commands on sprite"

    # Check env var injection (temp file upload)
    assert_contains "$MOCK_LOG" "sprite exec.*-file.*/tmp/env_config" "Uploads env config to sprite"

    # Check final interactive launch (flag order varies: -s NAME -tty or -tty -s NAME)
    assert_contains "$MOCK_LOG" "sprite exec.*-tty.*" "Launches interactive session"

    # Script-specific assertions
    case "$script_name" in
        claude)
            assert_contains "$MOCK_LOG" "claude install" "Installs Claude Code"
            assert_contains "$MOCK_LOG" "sprite exec.*-file.*/tmp/claude_settings" "Uploads Claude settings"
            assert_contains "$MOCK_LOG" "sprite exec.*-file.*/tmp/claude_global" "Uploads Claude global state"
            ;;
        openclaw)
            assert_contains "$MOCK_LOG" "sprite exec.*bun install -g openclaw" "Installs openclaw via bun"
            assert_contains "$MOCK_LOG" "sprite exec.*openclaw gateway" "Starts openclaw gateway"
            ;;
        nanoclaw)
            assert_contains "$MOCK_LOG" "sprite exec.*git clone.*nanoclaw" "Clones nanoclaw repo"
            assert_contains "$MOCK_LOG" "sprite exec.*-file.*/tmp/nanoclaw_env" "Uploads nanoclaw .env"
            ;;
    esac

    # Check no temp files leaked
    local leaked_temps=$(find /tmp -maxdepth 1 -name "tmp.*" -newer "$MOCK_LOG" 2>/dev/null | wc -l)
    if [[ "$leaked_temps" -eq 0 ]]; then
        echo -e "  ${GREEN}✓${NC} No temp files leaked"
        ((PASSED++))
    fi
}

# --- Test common.sh sourcing ---
test_common_source() {
    echo ""
    echo -e "${YELLOW}━━━ Testing common.sh ━━━${NC}"

    # Test 1: Source locally and check all functions exist
    local output
    output=$(bash -c '
        source "'"$REPO_ROOT"'/sprite/lib/common.sh"
        for fn in log_info log_warn log_error safe_read \
                  ensure_sprite_installed ensure_sprite_authenticated \
                  get_sprite_name ensure_sprite_exists verify_sprite_connectivity \
                  run_sprite setup_shell_environment \
                  get_openrouter_api_key_manual try_oauth_flow \
                  get_openrouter_api_key_oauth open_browser; do
            type "$fn" &>/dev/null && echo "OK:$fn" || echo "MISSING:$fn"
        done
    ' 2>/dev/null)

    local missing=$(echo "$output" | grep "^MISSING:" || true)
    if [[ -z "$missing" ]]; then
        echo -e "  ${GREEN}✓${NC} All functions defined"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} Missing functions: $missing"
        ((FAILED++))
    fi

    # Test 2: log functions write to stderr, not stdout
    local stdout stderr
    stdout=$(timeout 5 bash -c 'source "'"$REPO_ROOT"'/sprite/lib/common.sh" && log_info "test"' </dev/null 2>/dev/null)
    stderr=$(timeout 5 bash -c 'source "'"$REPO_ROOT"'/sprite/lib/common.sh" && log_info "test"' </dev/null 2>&1 >/dev/null)
    if [[ -z "$stdout" && -n "$stderr" ]]; then
        echo -e "  ${GREEN}✓${NC} Log functions write to stderr"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} Log functions should write to stderr only"
        ((FAILED++))
    fi

    # Test 3: get_sprite_name uses SPRITE_NAME env var
    local name
    name=$(timeout 5 bash -c 'SPRITE_NAME=from-env; source "'"$REPO_ROOT"'/sprite/lib/common.sh" && get_sprite_name' 2>/dev/null)
    if [[ "$name" == "from-env" ]]; then
        echo -e "  ${GREEN}✓${NC} get_sprite_name reads SPRITE_NAME env var"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} get_sprite_name should return 'from-env', got '$name'"
        ((FAILED++))
    fi

    # Test 4: get_sprite_name fails gracefully without TTY or env var
    local rc=0
    timeout 5 bash -c 'SPRITE_NAME=""; source "'"$REPO_ROOT"'/sprite/lib/common.sh" && get_sprite_name' </dev/null >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        echo -e "  ${GREEN}✓${NC} get_sprite_name fails without TTY or env var"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} get_sprite_name should fail without input"
        ((FAILED++))
    fi

    # Test 5: Syntax check
    if bash -n "$REPO_ROOT/sprite/lib/common.sh" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Syntax valid"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} Syntax errors"
        ((FAILED++))
    fi

    # Test 6: Remote source (if --remote)
    if [[ "$REMOTE" == true ]]; then
        local remote_fns
        remote_fns=$(bash -c '
            source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sprite/lib/common.sh)
            type log_info &>/dev/null && echo "OK" || echo "FAIL"
        ' 2>/dev/null)
        if [[ "$remote_fns" == "OK" ]]; then
            echo -e "  ${GREEN}✓${NC} Remote source from GitHub works"
            ((PASSED++))
        else
            echo -e "  ${RED}✗${NC} Remote source from GitHub failed"
            ((FAILED++))
        fi
    fi
}

# --- Test shared/common.sh functions ---
test_shared_common() {
    echo ""
    echo -e "${YELLOW}━━━ Testing shared/common.sh ━━━${NC}"

    # Test 1: validate_model_id accepts valid model IDs
    local result
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && validate_model_id "anthropic/claude-3.5-sonnet" && echo "valid"' 2>/dev/null)
    if [[ "$result" == "valid" ]]; then
        echo -e "  ${GREEN}✓${NC} validate_model_id accepts valid model IDs"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} validate_model_id should accept 'anthropic/claude-3.5-sonnet'"
        ((FAILED++))
    fi

    # Test 2: validate_model_id rejects invalid characters
    local rc=0
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && validate_model_id "bad;model"' </dev/null >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        echo -e "  ${GREEN}✓${NC} validate_model_id rejects invalid characters"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} validate_model_id should reject 'bad;model'"
        ((FAILED++))
    fi

    # Test 3: validate_model_id accepts empty string
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && validate_model_id "" && echo "valid"' 2>/dev/null)
    if [[ "$result" == "valid" ]]; then
        echo -e "  ${GREEN}✓${NC} validate_model_id accepts empty string"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} validate_model_id should accept empty string"
        ((FAILED++))
    fi

    # Test 4: json_escape handles special characters
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && json_escape "test\"quote"' 2>/dev/null)
    if [[ "$result" == *'\\"'* ]] || [[ "$result" == *'\"'* ]]; then
        echo -e "  ${GREEN}✓${NC} json_escape handles special characters"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} json_escape should escape quotes"
        ((FAILED++))
    fi

    # Test 5: generate_ssh_key_if_missing creates key if missing
    local test_key="$TEST_DIR/test_id_ed25519"
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && generate_ssh_key_if_missing "'"$test_key"'"' >/dev/null 2>&1
    if [[ -f "$test_key" && -f "${test_key}.pub" ]]; then
        echo -e "  ${GREEN}✓${NC} generate_ssh_key_if_missing creates key"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} generate_ssh_key_if_missing should create key at $test_key"
        ((FAILED++))
    fi

    # Test 6: generate_ssh_key_if_missing skips if key exists
    local mtime_before=$(stat -c %Y "$test_key" 2>/dev/null || stat -f %m "$test_key" 2>/dev/null)
    sleep 1
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && generate_ssh_key_if_missing "'"$test_key"'"' >/dev/null 2>&1
    local mtime_after=$(stat -c %Y "$test_key" 2>/dev/null || stat -f %m "$test_key" 2>/dev/null)
    if [[ "$mtime_before" == "$mtime_after" ]]; then
        echo -e "  ${GREEN}✓${NC} generate_ssh_key_if_missing skips existing key"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} generate_ssh_key_if_missing should not recreate existing key"
        ((FAILED++))
    fi

    # Test 7: get_ssh_fingerprint returns fingerprint
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && get_ssh_fingerprint "'"${test_key}.pub"'"' 2>/dev/null)
    if [[ -n "$result" && "$result" =~ ^[a-f0-9:]+$ ]]; then
        echo -e "  ${GREEN}✓${NC} get_ssh_fingerprint returns valid fingerprint"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} get_ssh_fingerprint should return hex fingerprint, got '$result'"
        ((FAILED++))
    fi

    # Test 8: Syntax check for shared/common.sh
    if bash -n "$REPO_ROOT/shared/common.sh" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} shared/common.sh syntax valid"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} shared/common.sh has syntax errors"
        ((FAILED++))
    fi

    # Test 9: All logging functions exist in shared/common.sh
    output=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        for fn in log_info log_warn log_error; do
            type "$fn" &>/dev/null && echo "OK:$fn" || echo "MISSING:$fn"
        done
    ' 2>/dev/null)
    missing=$(echo "$output" | grep "^MISSING:" || true)
    if [[ -z "$missing" ]]; then
        echo -e "  ${GREEN}✓${NC} All logging functions exist in shared/common.sh"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} Missing logging functions: $missing"
        ((FAILED++))
    fi

    # Test 10: extract_ssh_key_ids parses JSON correctly
    local mock_json='{"ssh_keys":[{"id":123},{"id":456}]}'
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && echo '"'$mock_json'"' | extract_ssh_key_ids "$(cat)" "ssh_keys"' 2>/dev/null)
    if [[ "$result" == "[123, 456]" ]] || [[ "$result" == "[123,456]" ]]; then
        echo -e "  ${GREEN}✓${NC} extract_ssh_key_ids parses JSON correctly"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} extract_ssh_key_ids should return [123, 456], got '$result'"
        ((FAILED++))
    fi

    # Test 11: nc_listen detects busybox nc and adds -p flag
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        # Mock nc command that returns busybox help
        nc() {
            if [[ "$1" == "--help" ]]; then
                echo "BusyBox nc"
                return 0
            fi
            echo "nc_args: $*"
        }
        export -f nc
        nc_listen 8080
    ' 2>/dev/null)
    if [[ "$result" == *"-l -p 8080"* ]]; then
        echo -e "  ${GREEN}✓${NC} nc_listen adds -p flag for busybox nc"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} nc_listen should add -p flag for busybox, got '$result'"
        ((FAILED++))
    fi

    # Test 12: nc_listen uses standard nc without -p flag
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        # Mock nc command that returns non-busybox help
        nc() {
            if [[ "$1" == "--help" ]]; then
                echo "OpenBSD netcat"
                return 1
            fi
            echo "nc_args: $*"
        }
        export -f nc
        nc_listen 8080
    ' 2>/dev/null)
    if [[ "$result" == *"-l 8080"* ]] && [[ "$result" != *"-p"* ]]; then
        echo -e "  ${GREEN}✓${NC} nc_listen uses standard nc without -p flag"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} nc_listen should omit -p flag for standard nc, got '$result'"
        ((FAILED++))
    fi

    # Test 13: open_browser detects termux-open-url
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        termux-open-url() { echo "termux: $*"; }
        export -f termux-open-url
        open_browser "https://example.com"
    ' 2>/dev/null)
    if [[ "$result" == "termux: https://example.com" ]]; then
        echo -e "  ${GREEN}✓${NC} open_browser detects termux-open-url"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} open_browser should use termux-open-url, got '$result'"
        ((FAILED++))
    fi

    # Test 14: open_browser detects macOS open
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        open() { echo "macOS: $*"; }
        export -f open
        open_browser "https://example.com"
    ' 2>/dev/null)
    if [[ "$result" == "macOS: https://example.com" ]]; then
        echo -e "  ${GREEN}✓${NC} open_browser detects macOS open"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} open_browser should use macOS open, got '$result'"
        ((FAILED++))
    fi

    # Test 15: open_browser detects xdg-open
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        xdg-open() { echo "xdg: $*"; }
        export -f xdg-open
        open_browser "https://example.com"
    ' 2>/dev/null)
    if [[ "$result" == "xdg: https://example.com" ]]; then
        echo -e "  ${GREEN}✓${NC} open_browser detects xdg-open"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} open_browser should use xdg-open, got '$result'"
        ((FAILED++))
    fi

    # Test 16: get_cloud_init_userdata returns valid YAML
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && get_cloud_init_userdata' 2>/dev/null)
    if [[ "$result" == *"#cloud-config"* ]] && [[ "$result" == *"package_update"* ]]; then
        echo -e "  ${GREEN}✓${NC} get_cloud_init_userdata returns valid YAML"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} get_cloud_init_userdata should return cloud-init YAML"
        ((FAILED++))
    fi

    # Test 17: get_cloud_init_userdata includes required packages
    if [[ "$result" == *"curl"* ]] && [[ "$result" == *"git"* ]] && [[ "$result" == *"zsh"* ]]; then
        echo -e "  ${GREEN}✓${NC} get_cloud_init_userdata includes required packages"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} get_cloud_init_userdata should include curl, git, zsh"
        ((FAILED++))
    fi

    # Test 18: get_cloud_init_userdata includes Bun and Claude installation
    if [[ "$result" == *"bun.sh/install"* ]] && [[ "$result" == *"claude.ai/install"* ]]; then
        echo -e "  ${GREEN}✓${NC} get_cloud_init_userdata includes Bun and Claude installation"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} get_cloud_init_userdata should include Bun and Claude install"
        ((FAILED++))
    fi

    # Test 19: create_oauth_response_html returns valid HTTP response
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && create_oauth_response_html' 2>/dev/null)
    if [[ "$result" == *"HTTP/1.1 200 OK"* ]] && [[ "$result" == *"Authentication Successful"* ]]; then
        echo -e "  ${GREEN}✓${NC} create_oauth_response_html returns valid HTTP response"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} create_oauth_response_html should return HTTP 200 response"
        ((FAILED++))
    fi

    # Test 20: wait_for_oauth_code returns success when file exists
    local code_test_file="$TEST_DIR/oauth_code_test"
    echo "test_code" > "$code_test_file"
    rc=0
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && wait_for_oauth_code "'"$code_test_file"'" 1' >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        echo -e "  ${GREEN}✓${NC} wait_for_oauth_code returns success when file exists"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} wait_for_oauth_code should return 0 when file exists"
        ((FAILED++))
    fi

    # Test 21: wait_for_oauth_code returns failure on timeout
    local missing_file="$TEST_DIR/missing_oauth_code"
    rc=0
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && wait_for_oauth_code "'"$missing_file"'" 1' >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        echo -e "  ${GREEN}✓${NC} wait_for_oauth_code returns failure on timeout"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} wait_for_oauth_code should return non-zero on timeout"
        ((FAILED++))
    fi

    # Test 22: cleanup_oauth_session removes directory
    local cleanup_test_dir="$TEST_DIR/oauth_cleanup_test"
    mkdir -p "$cleanup_test_dir"
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && cleanup_oauth_session "" "'"$cleanup_test_dir"'"' >/dev/null 2>&1
    if [[ ! -d "$cleanup_test_dir" ]]; then
        echo -e "  ${GREEN}✓${NC} cleanup_oauth_session removes directory"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} cleanup_oauth_session should remove directory"
        ((FAILED++))
    fi

    # Test 23: generic_ssh_wait succeeds when command passes
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        # Mock ssh that always succeeds
        ssh() { return 0; }
        export -f ssh
        generic_ssh_wait "1.2.3.4" "-o Test" "true" "test" 2 1 2>&1
        echo $?
    ' 2>/dev/null | tail -1)
    if [[ "$result" == "0" ]]; then
        echo -e "  ${GREEN}✓${NC} generic_ssh_wait succeeds when command passes"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} generic_ssh_wait should return 0 on success, got '$result'"
        ((FAILED++))
    fi

    # Test 24: generic_ssh_wait fails after max attempts
    result=$(bash -c '
        source "'"$REPO_ROOT"'/shared/common.sh"
        # Mock ssh that always fails
        ssh() { return 1; }
        export -f ssh
        generic_ssh_wait "1.2.3.4" "-o Test" "false" "test" 2 1 2>&1
        echo $?
    ' 2>/dev/null | tail -1)
    if [[ "$result" == "1" ]]; then
        echo -e "  ${GREEN}✓${NC} generic_ssh_wait fails after max attempts"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} generic_ssh_wait should return 1 after max attempts, got '$result'"
        ((FAILED++))
    fi

    # Test 25: safe_read fails when no TTY available
    rc=0
    bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && safe_read "test: "' </dev/null >/dev/null 2>&1 || rc=$?
    if [[ "$rc" -ne 0 ]]; then
        echo -e "  ${GREEN}✓${NC} safe_read fails when no TTY available"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} safe_read should fail without TTY"
        ((FAILED++))
    fi

    # Test 26: validate_model_id accepts openrouter/auto
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && validate_model_id "openrouter/auto" && echo "valid"' 2>/dev/null)
    if [[ "$result" == "valid" ]]; then
        echo -e "  ${GREEN}✓${NC} validate_model_id accepts openrouter/auto"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} validate_model_id should accept 'openrouter/auto'"
        ((FAILED++))
    fi

    # Test 27: validate_model_id accepts model IDs with colons
    result=$(bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && validate_model_id "provider/model:version" && echo "valid"' 2>/dev/null)
    if [[ "$result" == "valid" ]]; then
        echo -e "  ${GREEN}✓${NC} validate_model_id accepts model IDs with colons"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} validate_model_id should accept colons in model IDs"
        ((FAILED++))
    fi

    # Test 28: validate_model_id rejects shell metacharacters
    local dangerous_chars=('$' '&' '|' '`' '>' '<' '(' ')' '{' '}')
    local rejected_count=0
    for char in "${dangerous_chars[@]}"; do
        rc=0
        bash -c 'source "'"$REPO_ROOT"'/shared/common.sh" && validate_model_id "bad'"$char"'model"' </dev/null >/dev/null 2>&1 || rc=$?
        [[ "$rc" -ne 0 ]] && ((rejected_count++))
    done
    if [[ "$rejected_count" -eq "${#dangerous_chars[@]}" ]]; then
        echo -e "  ${GREEN}✓${NC} validate_model_id rejects shell metacharacters"
        ((PASSED++))
    else
        echo -e "  ${RED}✗${NC} validate_model_id should reject all shell metacharacters ($rejected_count/${#dangerous_chars[@]})"
        ((FAILED++))
    fi
}

# --- Test source detection in each script ---
test_source_detection() {
    echo ""
    echo -e "${YELLOW}━━━ Testing source detection ━━━${NC}"

    for script in claude openclaw nanoclaw; do
        local script_path="$REPO_ROOT/sprite/${script}.sh"
        [[ -f "$script_path" ]] || continue

        # Verify the source block checks for local file existence
        if grep -q 'if \[\[ -f "$SCRIPT_DIR/lib/common.sh" \]\]' "$script_path"; then
            echo -e "  ${GREEN}✓${NC} ${script}.sh uses file-existence check for sourcing"
            ((PASSED++))
        else
            echo -e "  ${RED}✗${NC} ${script}.sh missing file-existence source check"
            ((FAILED++))
        fi

        # Verify syntax
        if bash -n "$script_path" 2>/dev/null; then
            echo -e "  ${GREEN}✓${NC} ${script}.sh syntax valid"
            ((PASSED++))
        else
            echo -e "  ${RED}✗${NC} ${script}.sh syntax error"
            ((FAILED++))
        fi
    done
}

# --- Main ---
echo "==============================="
echo " Spawn Script Test Suite"
echo "==============================="
echo ""
echo "Repo:     $REPO_ROOT"
echo "Temp dir: $TEST_DIR"
echo "Filter:   ${FILTER:-all}"
echo "Remote:   $REMOTE"

setup_mocks
setup_extra_mocks

test_common_source
test_shared_common
test_source_detection

# Run per-script tests
for script in claude openclaw nanoclaw; do
    if [[ -n "$FILTER" && "$FILTER" != "$script" && "$FILTER" != "--remote" ]]; then
        continue
    fi
    [[ -f "$REPO_ROOT/sprite/${script}.sh" ]] && run_script_test "$script"
done

# --- Summary ---
echo ""
echo "==============================="
TOTAL=$((PASSED + FAILED))
echo -e " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${TOTAL} total"
echo "==============================="

[[ "$FAILED" -eq 0 ]] && exit 0 || exit 1
