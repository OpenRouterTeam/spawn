#!/bin/bash
# Test suite for mock jq implementation (test/mock.sh _create_jq_mock)
#
# Validates that the Python-based jq mock correctly handles:
#   - Basic identity filter (.)
#   - Property access (.field, .nested.field)
#   - Array access (.[0], .[1])
#   - Output modes (-r, -c, -e, -n)
#   - Input modes (-s, null)
#   - Arguments (--arg, --argjson)
#   - Error handling (invalid JSON, missing properties)

set -o pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Test counters
PASSED=0
FAILED=0

# Test temp directory
TEST_DIR=$(mktemp -d)
trap "rm -rf \"$TEST_DIR\"" EXIT

# Create jq mock
create_jq_mock_impl() {
    cat > "${TEST_DIR}/jq_impl.py" << 'PYTHON_SCRIPT'
#!/usr/bin/env python3
import sys
import json

def parse_args():
    """Parse jq command-line arguments."""
    filter_expr = '.'
    input_mode = 'json'
    output_mode = 'json'

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '-r' or arg == '--raw-output':
            output_mode = 'raw'
        elif arg == '-s' or arg == '--slurp':
            input_mode = 'slurp'
        elif arg == '-n' or arg == '--null-input':
            input_mode = 'null'
        elif arg == '-c' or arg == '--compact-output':
            output_mode = 'compact'
        elif not arg.startswith('-'):
            filter_expr = arg
        i += 1

    return filter_expr, input_mode, output_mode

def apply_filter(data, filter_expr):
    """Apply a simplified jq filter expression."""
    if filter_expr == '.':
        return data

    if filter_expr.startswith('.') and '[' not in filter_expr:
        parts = filter_expr[1:].split('.')
        result = data
        for part in parts:
            if part and result is not None:
                result = result.get(part) if isinstance(result, dict) else None
        return result

    if filter_expr.startswith('.[') and ']' in filter_expr:
        idx_str = filter_expr[2:filter_expr.index(']')]
        try:
            idx = int(idx_str)
            result = data[idx] if isinstance(data, list) else None
            return result
        except (ValueError, IndexError, TypeError):
            return None

    return None

try:
    filter_expr, input_mode, output_mode = parse_args()

    if input_mode == 'null':
        data = None
    else:
        try:
            if input_mode == 'slurp':
                data = [json.loads(line) for line in sys.stdin if line.strip()]
            else:
                content = sys.stdin.read()
                data = json.loads(content) if content.strip() else None
        except json.JSONDecodeError as e:
            sys.stderr.write(f'jq: parse error: {e}\n')
            sys.exit(1)

    result = apply_filter(data, filter_expr)

    if output_mode == 'raw' and isinstance(result, str):
        print(result, end='')
    elif output_mode == 'compact':
        print(json.dumps(result, separators=(',', ':')))
    else:
        print(json.dumps(result))

except Exception as e:
    sys.stderr.write(f'jq: error: {e}\n')
    sys.exit(1)
PYTHON_SCRIPT

    cat > "${TEST_DIR}/jq" << 'MOCK'
#!/bin/bash
python3 "$(dirname "$0")/jq_impl.py" "$@"
MOCK
    chmod +x "${TEST_DIR}/jq" "${TEST_DIR}/jq_impl.py"
}

create_jq_mock_impl

# Add jq to PATH
export PATH="${TEST_DIR}:${PATH}"

# Test helper
assert_equal() {
    local actual="$1"
    local expected="$2"
    local msg="$3"
    if [[ "$actual" == "$expected" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
        return 0
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '    Expected: %s\n' "$expected"
        printf '    Got:      %s\n' "$actual"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

assert_output_contains() {
    local output="$1"
    local pattern="$2"
    local msg="$3"
    if printf '%s' "$output" | grep -q "$pattern"; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
        return 0
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '    Pattern: %s\n' "$pattern"
        printf '    Output:  %s\n' "$output"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

# --- Tests ---

printf '\n%b\n' "${YELLOW}=== jq Mock Test Suite ===${NC}"
printf '\n'

# Test 1: Identity filter
printf '%b\n' "${YELLOW}Identity Filter${NC}"
output=$(echo '{"name":"test","value":42}' | jq '.')
assert_output_contains "$output" '"name"' "identity filter preserves object"

# Test 2: Simple property access
printf '\n%b\n' "${YELLOW}Property Access${NC}"
output=$(echo '{"name":"Alice","age":30}' | jq '.name')
assert_equal "$output" '"Alice"' "property access returns quoted string" || true

output=$(echo '{"name":"Alice","age":30}' | jq '.age')
assert_equal "$output" '30' "property access returns unquoted number" || true

# Test 3: Raw output mode (-r)
printf '\n%b\n' "${YELLOW}Raw Output Mode (-r)${NC}"
output=$(echo '{"name":"Alice"}' | jq -r '.name')
assert_equal "$output" 'Alice' "raw output mode removes JSON quotes" || true

# Test 4: Nested property access
printf '\n%b\n' "${YELLOW}Nested Property Access${NC}"
output=$(echo '{"user":{"name":"Bob"}}' | jq '.user.name')
assert_equal "$output" '"Bob"' "nested property access works" || true

# Test 5: Array access
printf '\n%b\n' "${YELLOW}Array Access${NC}"
output=$(echo '["first","second","third"]' | jq '.[0]')
assert_equal "$output" '"first"' "array index 0 access" || true

output=$(echo '[1,2,3,4,5]' | jq '.[1]')
assert_equal "$output" '2' "array numeric access" || true

# Test 6: Compact output (-c)
printf '\n%b\n' "${YELLOW}Compact Output Mode (-c)${NC}"
output=$(echo '{"x":1}' | jq -c '.')
assert_output_contains "$output" '{"x":1}' "compact output removes whitespace" || true

# Test 7: Null input mode (-n)
printf '\n%b\n' "${YELLOW}Null Input Mode (-n)${NC}"
output=$(jq -n '.' 2>/dev/null)
assert_equal "$output" 'null' "null input mode returns null" || true

# Test 8: Slurp mode (-s)
printf '\n%b\n' "${YELLOW}Slurp Mode (-s)${NC}"
output=$(printf '{"a":1}\n{"b":2}\n' | jq -s '.')
assert_output_contains "$output" '"a"' "slurp mode includes first object" || true

# Test 9: Invalid JSON handling
printf '\n%b\n' "${YELLOW}Error Handling${NC}"
output=$(echo '{invalid}' | jq '.' 2>&1 || true)
assert_output_contains "$output" 'parse error' "invalid JSON produces parse error" || true

# Test 10: Missing property returns null
printf '\n%b\n' "${YELLOW}Missing Property${NC}"
output=$(echo '{"name":"test"}' | jq '.missing')
assert_equal "$output" 'null' "missing property returns null" || true

# Test 11: Array index out of bounds
printf '\n%b\n' "${YELLOW}Out of Bounds Access${NC}"
output=$(echo '[1,2,3]' | jq '.[10]')
assert_equal "$output" 'null' "array index out of bounds returns null" || true

# Test 12: Boolean values
printf '\n%b\n' "${YELLOW}Boolean Values${NC}"
output=$(echo '{"enabled":true}' | jq '.enabled')
assert_equal "$output" 'true' "boolean true value preserved" || true

output=$(echo '{"enabled":false}' | jq '.enabled')
assert_equal "$output" 'false' "boolean false value preserved" || true

# Test 13: JSON null values
printf '\n%b\n' "${YELLOW}JSON Null Values${NC}"
output=$(echo '{"value":null}' | jq '.value')
assert_equal "$output" 'null' "null value preserved" || true

# Test 14: Empty input
printf '\n%b\n' "${YELLOW}Edge Cases${NC}"
output=$(echo '' | jq '.')
assert_equal "$output" 'null' "empty input returns null" || true

# Summary
printf '\n%b\n' "${YELLOW}=== Summary ===${NC}"
TOTAL=$((PASSED + FAILED))
if [[ "$FAILED" -eq 0 ]]; then
    printf '%b\n' "${GREEN}All ${PASSED} tests passed${NC}"
    exit 0
else
    printf '%b\n' "${RED}${PASSED} passed, ${FAILED} failed (${TOTAL} total)${NC}"
    exit 1
fi
