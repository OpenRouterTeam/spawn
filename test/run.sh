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
