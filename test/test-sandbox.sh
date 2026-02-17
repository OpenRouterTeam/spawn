#!/bin/bash
# Test that all bash test scripts are properly sandboxed
# Verifies no production environment pollution

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

assert_no_file() {
    local pattern="$1"
    local msg="$2"
    if ls ${pattern} 2>/dev/null | grep -q .; then
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '%b\n' "    Found: $(ls ${pattern} 2>/dev/null | head -3)"
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    fi
}

assert_config_not_modified() {
    local config_path="$HOME/.config/spawn"
    local msg="$1"

    # If config doesn't exist, that's fine
    if [[ ! -d "$config_path" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg} (dir doesn't exist)"
        PASSED=$((PASSED + 1))
        return 0
    fi

    # If it exists, check if any files were modified in last 5 minutes
    local recent_files
    recent_files=$(find "$config_path" -type f -mmin -5 2>/dev/null)
    if [[ -n "$recent_files" ]]; then
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '%b\n' "    Modified: $recent_files"
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    fi
}

echo "========================================"
echo " Bash Test Sandboxing Verification"
echo "========================================"
echo ""

# Test 1: Run test/run.sh and verify no /tmp pollution
echo "${YELLOW}Test 1: test/run.sh sandboxing${NC}"
cd "${REPO_ROOT}"
timeout 60 bash test/run.sh >/dev/null 2>&1 || true
assert_no_file "/tmp/sprite_mock_created*" "No sprite mock files in /tmp after test/run.sh"
assert_config_not_modified "Production config not modified by test/run.sh"

# Test 2: Verify test/record.sh respects TEST_CONFIG_DIR
echo ""
echo "${YELLOW}Test 2: test/record.sh sandboxing${NC}"
TEST_CONFIG_DIR=$(mktemp -d)
export TEST_CONFIG_DIR
timeout 10 bash test/record.sh --list >/dev/null 2>&1 || true
assert_no_file "$HOME/.config/spawn/*.json.test-*" "No test files in production config"
rm -rf "${TEST_CONFIG_DIR}"
unset TEST_CONFIG_DIR

# Test 3: Verify mock.sh uses isolated temp directories
echo ""
echo "${YELLOW}Test 3: test/mock.sh sandboxing${NC}"
# Mock test runs in parallel with isolated TEST_DIR per cloud
# Just verify it doesn't leave artifacts in /tmp or production dirs
timeout 10 bash test/mock.sh hetzner claude 2>/dev/null || true
assert_config_not_modified "Production config not modified by test/mock.sh"

echo ""
echo "========================================"
TOTAL=$((PASSED + FAILED))
printf '%b\n' " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${TOTAL} total"
echo "========================================"

[[ "${FAILED}" -eq 0 ]] && exit 0 || exit 1
