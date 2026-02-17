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

# Capture initial state of agent directories before running tests
INITIAL_OPENCLAW_EXISTS=false
INITIAL_SPRITE_EXISTS=false
INITIAL_CLAUDE_DIR_EXISTS=false
INITIAL_CLAUDE_JSON_EXISTS=false
INITIAL_CLAUDE_SETTINGS_EXISTS=false
INITIAL_CLAUDE_JSON_MTIME=""
INITIAL_CLAUDE_SETTINGS_MTIME=""

[[ -d "$HOME/.openclaw" ]] && INITIAL_OPENCLAW_EXISTS=true
[[ -d "$HOME/.sprite" ]] && INITIAL_SPRITE_EXISTS=true
[[ -d "$HOME/.claude" ]] && INITIAL_CLAUDE_DIR_EXISTS=true

if [[ -f "$HOME/.claude.json" ]]; then
    INITIAL_CLAUDE_JSON_EXISTS=true
    INITIAL_CLAUDE_JSON_MTIME=$(stat -c %Y "$HOME/.claude.json" 2>/dev/null || stat -f %m "$HOME/.claude.json" 2>/dev/null)
fi

if [[ -f "$HOME/.claude/settings.json" ]]; then
    INITIAL_CLAUDE_SETTINGS_EXISTS=true
    INITIAL_CLAUDE_SETTINGS_MTIME=$(stat -c %Y "$HOME/.claude/settings.json" 2>/dev/null || stat -f %m "$HOME/.claude/settings.json" 2>/dev/null)
fi

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

assert_no_directory() {
    local dir_path="$1"
    local msg="$2"
    if [[ -d "$dir_path" ]]; then
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '%b\n' "    Found: $dir_path"
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

# Test 4: Verify no agent-specific directories created in HOME
echo ""
echo "${YELLOW}Test 4: Agent directory residue check${NC}"

# Check if .openclaw was created by tests
if [[ "$INITIAL_OPENCLAW_EXISTS" == "false" ]]; then
    assert_no_directory "$HOME/.openclaw" "No ~/.openclaw directory created"
else
    printf '%b\n' "  ${YELLOW}⊘${NC} Skipped ~/.openclaw check (existed before tests)"
fi

# Check if .sprite was created by tests
if [[ "$INITIAL_SPRITE_EXISTS" == "false" ]]; then
    assert_no_directory "$HOME/.sprite" "No ~/.sprite directory created"
else
    printf '%b\n' "  ${YELLOW}⊘${NC} Skipped ~/.sprite check (existed before tests)"
fi

# Check if .claude was created by tests
if [[ "$INITIAL_CLAUDE_DIR_EXISTS" == "false" ]]; then
    assert_no_directory "$HOME/.claude" "No ~/.claude directory created"
else
    printf '%b\n' "  ${YELLOW}⊘${NC} Skipped ~/.claude check (existed before tests)"
fi

# Test 5: Verify Claude settings not mutated in production config
echo ""
echo "${YELLOW}Test 5: Claude settings integrity${NC}"

# Check .claude.json mutation only if it existed before tests
if [[ "$INITIAL_CLAUDE_JSON_EXISTS" == "true" ]]; then
    # Compare modification time before and after tests
    CURRENT_MTIME=$(stat -c %Y "$HOME/.claude.json" 2>/dev/null || stat -f %m "$HOME/.claude.json" 2>/dev/null)
    if [[ "$CURRENT_MTIME" != "$INITIAL_CLAUDE_JSON_MTIME" ]]; then
        printf '%b\n' "  ${RED}✗${NC} Production ~/.claude.json was modified by tests"
        printf '%b\n' "    File: $HOME/.claude.json"
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "  ${GREEN}✓${NC} Production ~/.claude.json not modified by tests"
        PASSED=$((PASSED + 1))
    fi
elif [[ -f "$HOME/.claude.json" ]]; then
    # File was created by tests
    printf '%b\n' "  ${RED}✗${NC} ~/.claude.json should not be created by tests"
    printf '%b\n' "    Created: $HOME/.claude.json"
    FAILED=$((FAILED + 1))
else
    printf '%b\n' "  ${GREEN}✓${NC} ~/.claude.json not created by tests"
    PASSED=$((PASSED + 1))
fi

# Check settings.json mutation only if it existed before tests
if [[ "$INITIAL_CLAUDE_SETTINGS_EXISTS" == "true" ]]; then
    # Compare modification time before and after tests
    CURRENT_MTIME=$(stat -c %Y "$HOME/.claude/settings.json" 2>/dev/null || stat -f %m "$HOME/.claude/settings.json" 2>/dev/null)
    if [[ "$CURRENT_MTIME" != "$INITIAL_CLAUDE_SETTINGS_MTIME" ]]; then
        printf '%b\n' "  ${RED}✗${NC} Production ~/.claude/settings.json was modified by tests"
        printf '%b\n' "    File: $HOME/.claude/settings.json"
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "  ${GREEN}✓${NC} Production ~/.claude/settings.json not modified by tests"
        PASSED=$((PASSED + 1))
    fi
elif [[ -f "$HOME/.claude/settings.json" ]]; then
    # File was created by tests
    printf '%b\n' "  ${RED}✗${NC} ~/.claude/settings.json should not be created by tests"
    printf '%b\n' "    Created: $HOME/.claude/settings.json"
    FAILED=$((FAILED + 1))
else
    printf '%b\n' "  ${GREEN}✓${NC} ~/.claude/settings.json not created by tests"
    PASSED=$((PASSED + 1))
fi

echo ""
echo "========================================"
TOTAL=$((PASSED + FAILED))
printf '%b\n' " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${TOTAL} total"
echo "========================================"

[[ "${FAILED}" -eq 0 ]] && exit 0 || exit 1
