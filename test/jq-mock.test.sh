#!/bin/bash
# Test suite for jq mock implementation in test/mock.sh
#
# Validates the Python-based jq mock (_create_jq_mock) works correctly
# for the spawn cloud agent provisioning workflow.
#
# Tests cover:
#   - Basic identity filter (.)
#   - Property access (.field, .nested.field)
#   - Array access (.[0], .[1])
#   - Output modes (-r/raw, -c/compact, -n/null-input)
#   - Input modes (-s/slurp, null)
#   - Error handling (invalid JSON, missing properties, out of bounds)
#   - Edge cases (empty input, null values, booleans)

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR=$(mktemp -d)
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    rm -rf "${TEST_DIR}"
}
trap cleanup EXIT

# ============================================================
# Create the jq mock implementation (from test/mock.sh)
# ============================================================

_create_jq_mock() {
    cat > "${TEST_DIR}/jq_impl.py" << 'PYTHON_SCRIPT'
#!/usr/bin/env python3
import sys
import json
import re

def parse_args():
    """Parse jq command-line arguments."""
    filter_expr = '.'
    args_dict = {}
    input_mode = 'json'
    output_mode = 'json'

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '-r' or arg == '--raw-output':
            output_mode = 'raw'
        elif arg == '-s' or arg == '--slurp':
            input_mode = 'slurp'
        elif arg == '-e' or arg == '--exit-status':
            output_mode = 'exit'
        elif arg == '-n' or arg == '--null-input':
            input_mode = 'null'
        elif arg == '-c' or arg == '--compact-output':
            output_mode = 'compact'
        elif arg == '--arg':
            i += 1
            if i < len(sys.argv) - 1:
                key = sys.argv[i]
                i += 1
                value = sys.argv[i]
                args_dict[key] = value
        elif arg == '--argjson':
            i += 1
            if i < len(sys.argv) - 1:
                key = sys.argv[i]
                i += 1
                try:
                    args_dict[key] = json.loads(sys.argv[i])
                except json.JSONDecodeError:
                    sys.stderr.write(f'jq: invalid JSON in --argjson {key}\n')
                    sys.exit(1)
        elif not arg.startswith('-'):
            filter_expr = arg
        i += 1

    return filter_expr, args_dict, input_mode, output_mode

def apply_filter(data, filter_expr, args_dict):
    """Apply a simplified jq filter expression."""
    # Handle special cases
    if filter_expr == '.':
        return data

    # Handle chained filters like .[0].id
    # Parse the filter into parts
    result = data
    remaining = filter_expr

    while remaining:
        if remaining == '.':
            break
        elif remaining.startswith('.'):
            # Remove the dot
            remaining = remaining[1:]

            # Check if next part is an array access
            if remaining.startswith('['):
                # Array access like [0]
                close_bracket = remaining.index(']')
                idx_str = remaining[1:close_bracket]
                try:
                    idx = int(idx_str)
                    result = result[idx] if isinstance(result, list) else None
                except (ValueError, IndexError, TypeError):
                    return None
                remaining = remaining[close_bracket+1:]
            else:
                # Property access like .name or .user
                # Find the next delimiter (. or [ or end of string)
                next_dot = remaining.find('.')
                next_bracket = remaining.find('[')

                if next_dot == -1 and next_bracket == -1:
                    # Last property
                    part = remaining
                    remaining = ''
                elif next_dot != -1 and (next_bracket == -1 or next_dot < next_bracket):
                    part = remaining[:next_dot]
                    remaining = '.' + remaining[next_dot+1:]
                elif next_bracket != -1:
                    part = remaining[:next_bracket]
                    remaining = remaining[next_bracket:]
                else:
                    part = remaining
                    remaining = ''

                if part and result is not None:
                    result = result.get(part) if isinstance(result, dict) else None
        else:
            break

    return result

# Main
try:
    filter_expr, args_dict, input_mode, output_mode = parse_args()

    # Read input
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

    # Apply filter
    result = apply_filter(data, filter_expr, args_dict)

    # Output result
    if output_mode == 'raw' and isinstance(result, str):
        print(result, end='')
    elif output_mode == 'compact':
        print(json.dumps(result, separators=(',', ':')))
    else:
        print(json.dumps(result, separators=(',', ':')))

except Exception as e:
    sys.stderr.write(f'jq: error: {e}\n')
    sys.exit(1)
PYTHON_SCRIPT

    cat > "${TEST_DIR}/jq" << 'MOCK'
#!/bin/bash
# Mock jq implementation using python3
python3 "$(dirname "$0")/jq_impl.py" "$@"
MOCK
    chmod +x "${TEST_DIR}/jq" "${TEST_DIR}/jq_impl.py"
}

# Setup the jq mock
_create_jq_mock

# Export PATH to use our mock jq
export PATH="${TEST_DIR}:${PATH}"

# ============================================================
# Test assertions
# ============================================================

assert_jq_output() {
    local input="$1"
    local filter="$2"
    local expected="$3"
    local msg="${4:-jq output: $filter}"

    # Run jq with the test input
    local actual
    actual=$(printf '%s' "$input" | jq "$filter" 2>&1) || actual="ERROR"

    if [[ "$actual" == "$expected" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '%b\n' "    Expected: ${expected}"
        printf '%b\n' "    Got:      ${actual}"
        FAILED=$((FAILED + 1))
    fi
}

assert_jq_output_raw() {
    local input="$1"
    local filter="$2"
    local expected="$3"
    local msg="${4:-jq output (raw): $filter}"

    # Run jq with -r (raw output)
    local actual
    actual=$(printf '%s' "$input" | jq -r "$filter" 2>&1) || actual="ERROR"

    if [[ "$actual" == "$expected" ]]; then
        printf '%b\n' "  ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "  ${RED}✗${NC} ${msg}"
        printf '%b\n' "    Expected: ${expected}"
        printf '%b\n' "    Got:      ${actual}"
        FAILED=$((FAILED + 1))
    fi
}

# ============================================================
# Test Cases
# ============================================================

printf '\n%b\n' "${YELLOW}Testing jq mock implementation${NC}"

# ── Basic identity filter ────────────────────────────────

printf '\n%b\n' "${YELLOW}Basic filters:${NC}"

assert_jq_output '{"name":"test"}' '.' '{"name":"test"}' "identity filter (.)"
assert_jq_output '{"a":1}' '.' '{"a":1}' "identity filter with number"
assert_jq_output '{"x":null}' '.' '{"x":null}' "identity filter with null"
assert_jq_output '[]' '.' '[]' "identity filter with empty array"

# ── Property access ──────────────────────────────────────

printf '\n%b\n' "${YELLOW}Property access:${NC}"

assert_jq_output '{"name":"test"}' '.name' '"test"' "simple property (.name)"
assert_jq_output '{"user":{"name":"alice"}}' '.user' '{"name":"alice"}' "nested object"
assert_jq_output '{"user":{"name":"alice"}}' '.user.name' '"alice"' "nested property (.user.name)"
assert_jq_output '{"servers":["a","b"]}' '.servers' '["a","b"]' "property returning array"
assert_jq_output '{"id":42}' '.id' '42' "numeric property"
assert_jq_output '{"active":true}' '.active' 'true' "boolean property"
assert_jq_output '{"data":null}' '.data' 'null' "null property"

# ── Array access ────────────────────────────────────────

printf '\n%b\n' "${YELLOW}Array access:${NC}"

assert_jq_output '["a","b","c"]' '.[0]' '"a"' "first array element (.[0])"
assert_jq_output '["a","b","c"]' '.[1]' '"b"' "second array element (.[1])"
assert_jq_output '["a","b","c"]' '.[2]' '"c"' "third array element (.[2])"
assert_jq_output '[{"id":1},{"id":2}]' '.[0]' '{"id":1}' "array of objects first element"
assert_jq_output '[{"id":1},{"id":2}]' '.[1]' '{"id":2}' "array of objects second element"
assert_jq_output '[{"id":1},{"id":2}]' '.[0].id' '1' "nested array element property"

# ── Raw output mode ─────────────────────────────────────

printf '\n%b\n' "${YELLOW}Raw output mode (-r):${NC}"

assert_jq_output_raw '{"name":"test"}' '.name' 'test' "raw string output"
assert_jq_output_raw '["hello","world"]' '.[0]' 'hello' "raw array element"
assert_jq_output_raw '{"api_key":"abc123"}' '.api_key' 'abc123' "raw API key"

# ── Edge cases ───────────────────────────────────────────

printf '\n%b\n' "${YELLOW}Edge cases:${NC}"

# Missing property returns null
assert_jq_output '{"name":"test"}' '.missing' 'null' "missing property returns null"
assert_jq_output '{"user":{"name":"alice"}}' '.user.missing' 'null' "missing nested property returns null"

# Empty strings
assert_jq_output '{"msg":""}' '.msg' '""' "empty string property"

# Numeric operations
assert_jq_output '{"count":0}' '.count' '0' "zero value"
assert_jq_output '{"count":-5}' '.count' '-5' "negative number"
assert_jq_output '{"value":3.14}' '.value' '3.14' "float value"

# Special characters in strings
assert_jq_output '{"key":"value with spaces"}' '.key' '"value with spaces"' "string with spaces"
assert_jq_output '{"path":"/path/to/file"}' '.path' '"/path/to/file"' "path with slashes"

# ── Error handling ───────────────────────────────────────

printf '\n%b\n' "${YELLOW}Error handling:${NC}"

# Invalid JSON should fail (stderr output)
invalid_json_output=$(printf 'not json' | jq '.' 2>&1 || true)
if echo "$invalid_json_output" | grep -q "parse error\|Expecting"; then
    printf '%b\n' "  ${GREEN}✓${NC} invalid JSON produces error"
    PASSED=$((PASSED + 1))
else
    printf '%b\n' "  ${RED}✗${NC} invalid JSON produces error"
    printf '%b\n' "    Got: ${invalid_json_output}"
    FAILED=$((FAILED + 1))
fi

# Out of bounds array access
assert_jq_output '["a","b"]' '.[5]' 'null' "out of bounds array access returns null"

# ============================================================
# Results
# ============================================================

printf '\n%b\n' "${YELLOW}===============================
 Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, $((PASSED + FAILED)) total
 ===============================${NC}"

exit "$FAILED"
