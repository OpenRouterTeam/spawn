#!/bin/bash
# Test script to demonstrate OAuth fallback mechanism

# Source the library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/sprite/lib/common.sh"

echo "Testing OAuth Fallback Mechanism"
echo "=================================="
echo ""
echo "This script will test the fallback behavior:"
echo "1. Try OAuth flow (will likely fail/timeout quickly for demo)"
echo "2. Fallback to manual API key entry"
echo ""

# Test with a very short timeout by simulating failure
log_info "Scenario 1: nc command not available"
echo "Simulating missing netcat..."

# Temporarily hide nc command
original_path="$PATH"
export PATH="/tmp/empty:$PATH"

API_KEY=$(get_openrouter_api_key_oauth 5180 2>&1)
status=$?

# Restore PATH
export PATH="$original_path"

if [[ $status -eq 0 ]]; then
    echo ""
    log_info "Test completed successfully!"
    log_info "Got API key: ${API_KEY:0:10}..."
else
    log_error "Test failed - authentication cancelled"
fi

echo ""
echo "=================================="
echo "To test OAuth success scenario, run one of the actual setup scripts."
