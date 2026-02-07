#!/bin/bash
# Shared bash functions used across all spawn scripts
# Provider-agnostic utilities for logging, input, OAuth, etc.
#
# This file is meant to be sourced by cloud provider-specific common.sh files.
# It does not set bash flags (like set -euo pipefail) as those should be set
# by the scripts that source this file.

# ============================================================
# Color definitions and logging
# ============================================================

# Use non-readonly vars to avoid errors if sourced multiple times
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Print colored messages (to stderr so they don't pollute command substitution output)
log_info() {
    echo -e "${GREEN}$1${NC}" >&2
}

log_warn() {
    echo -e "${YELLOW}$1${NC}" >&2
}

log_error() {
    echo -e "${RED}$1${NC}" >&2
}

# ============================================================
# Input handling
# ============================================================

# Safe read function that works in both interactive and non-interactive modes
safe_read() {
    local prompt="$1"
    local result=""

    if [[ -t 0 ]]; then
        # stdin is a terminal - read directly
        read -p "$prompt" result
    elif echo -n "" > /dev/tty 2>/dev/null; then
        # /dev/tty is functional - use it
        read -p "$prompt" result < /dev/tty
    else
        # No interactive input available
        log_error "Cannot read input: no TTY available"
        return 1
    fi

    echo "$result"
}

# ============================================================
# Network utilities
# ============================================================

# Listen on a port with netcat (handles busybox/Termux nc requiring -p flag)
nc_listen() {
    local port=$1
    shift
    # Detect if nc requires -p flag (busybox nc on Termux)
    if nc --help 2>&1 | grep -q "BusyBox\|busybox" || nc --help 2>&1 | grep -q "\-p "; then
        nc -l -p "$port" "$@"
    else
        nc -l "$port" "$@"
    fi
}

# Open browser to URL (supports macOS, Linux, Termux)
open_browser() {
    local url=$1
    if command -v termux-open-url &> /dev/null; then
        termux-open-url "$url" </dev/null
    elif command -v open &> /dev/null; then
        open "$url" </dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$url" </dev/null
    else
        log_warn "Please open: ${url}"
    fi
}

# Validate model ID to prevent command injection
validate_model_id() {
    local model_id="$1"
    if [[ -z "$model_id" ]]; then return 0; fi
    if [[ ! "$model_id" =~ ^[a-zA-Z0-9/_:.-]+$ ]]; then
        log_error "Invalid model ID: contains unsafe characters"
        log_error "Model IDs should only contain: letters, numbers, /, -, _, :, ."
        return 1
    fi
    return 0
}

# ============================================================
# OpenRouter authentication
# ============================================================

# Manually prompt for API key
get_openrouter_api_key_manual() {
    echo ""
    log_warn "Manual API Key Entry"
    echo -e "${YELLOW}Get your API key from: https://openrouter.ai/settings/keys${NC}"
    echo ""

    local api_key=""
    while [[ -z "$api_key" ]]; do
        api_key=$(safe_read "Enter your OpenRouter API key: ") || return 1

        # Basic validation - OpenRouter keys typically start with "sk-or-"
        if [[ -z "$api_key" ]]; then
            log_error "API key cannot be empty"
        elif [[ ! "$api_key" =~ ^sk-or-v1-[a-f0-9]{64}$ ]]; then
            log_warn "Warning: API key format doesn't match expected pattern (sk-or-v1-...)"
            local confirm=$(safe_read "Use this key anyway? (y/N): ") || return 1
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                break
            else
                api_key=""
            fi
        fi
    done

    log_info "API key accepted!"
    echo "$api_key"
}

# Try OAuth flow, fallback to manual entry if it fails
try_oauth_flow() {
    local callback_port=${1:-5180}

    log_warn "Attempting OAuth authentication..."

    # Check if nc is available
    if ! command -v nc &> /dev/null; then
        log_warn "netcat (nc) not found - OAuth server unavailable"
        return 1
    fi

    local callback_url="http://localhost:${callback_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"

    # Create a temporary directory for the OAuth flow
    local oauth_dir=$(mktemp -d)
    local code_file="$oauth_dir/code"

    log_warn "Starting local OAuth server on port ${callback_port}..."

    # Use a simpler nc approach - pipe response while capturing request
    (
        local success_response='HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><style>@keyframes checkmark{0%{transform:scale(0) rotate(-45deg);opacity:0}60%{transform:scale(1.2) rotate(-45deg);opacity:1}100%{transform:scale(1) rotate(-45deg);opacity:1}}@keyframes fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}.check{width:80px;height:80px;border-radius:50%;background:#00d4aa22;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.check::after{content:"";display:block;width:28px;height:14px;border-left:4px solid #00d4aa;border-bottom:4px solid #00d4aa;animation:checkmark .5s ease forwards}h1{color:#00d4aa;margin:0 0 8px;font-size:1.6rem}p{margin:0 0 6px;color:#ffffffcc;font-size:1rem}.sub{color:#ffffff66;font-size:.85rem;animation:fadein .5s ease .5s both}</style></head><body><div class="card"><div class="check"></div><h1>Authentication Successful!</h1><p>Redirecting back to terminal...</p><p class="sub">This tab will close automatically</p></div><script>setTimeout(function(){try{window.close()}catch(e){}setTimeout(function(){document.querySelector(".sub").textContent="You can safely close this tab"},500)},3000)</script></body></html>'

        while true; do
            # Listen and capture just the first line of the request, then respond
            local response_file=$(mktemp)
            echo -e "$success_response" > "$response_file"

            local request=$(nc_listen "$callback_port" < "$response_file" 2>/dev/null | head -1)
            local nc_status=$?
            rm -f "$response_file"

            # If nc failed, exit the loop
            if [[ $nc_status -ne 0 ]]; then
                break
            fi

            if [[ "$request" == *"/callback?code="* ]]; then
                local code=$(echo "$request" | sed -n 's/.*code=\([^ &]*\).*/\1/p')
                echo "$code" > "$code_file"
                break
            fi
        done
    ) </dev/null &
    local server_pid=$!

    # Give the server a moment to start and check if it's running
    sleep 1

    # Check if the background process is still running
    if ! kill -0 "$server_pid" 2>/dev/null; then
        log_warn "Failed to start OAuth server (port may be in use)"
        rm -rf "$oauth_dir"
        return 1
    fi

    # Open browser
    log_warn "Opening browser to authenticate with OpenRouter..."
    open_browser "$auth_url"

    # Wait for the code file to be created (timeout after 2 minutes)
    local timeout=120
    local elapsed=0
    while [[ ! -f "$code_file" ]] && [[ "$elapsed" -lt "$timeout" ]]; do
        sleep 1
        ((elapsed++))
    done

    # Kill the background server process
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true

    if [[ ! -f "$code_file" ]]; then
        log_warn "OAuth timeout - no response received"
        rm -rf "$oauth_dir"
        return 1
    fi

    local oauth_code=$(cat "$code_file")
    rm -rf "$oauth_dir"

    # Exchange the code for an API key
    log_warn "Exchanging OAuth code for API key..."
    local key_response=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" \
        -d "{\"code\": \"$oauth_code\"}")

    local api_key=$(echo "$key_response" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')

    if [[ -z "$api_key" ]]; then
        log_error "Failed to exchange OAuth code: ${key_response}"
        return 1
    fi

    log_info "Successfully obtained OpenRouter API key via OAuth!"
    echo "$api_key"
}

# Main function: Try OAuth, fallback to manual entry
get_openrouter_api_key_oauth() {
    local callback_port=${1:-5180}

    # Try OAuth flow first
    local api_key=$(try_oauth_flow "$callback_port")

    if [[ -n "$api_key" ]]; then
        echo "$api_key"
        return 0
    fi

    # OAuth failed, offer manual entry
    echo ""
    log_warn "OAuth authentication failed or unavailable"
    log_warn "You can enter your API key manually instead"
    echo ""
    local manual_choice=$(safe_read "Would you like to enter your API key manually? (Y/n): ") || {
        log_error "Cannot prompt for manual entry in non-interactive mode"
        log_warn "Set OPENROUTER_API_KEY environment variable for non-interactive usage"
        return 1
    }

    if [[ ! "$manual_choice" =~ ^[Nn]$ ]]; then
        api_key=$(get_openrouter_api_key_manual)
        echo "$api_key"
        return 0
    else
        log_error "Authentication cancelled by user"
        return 1
    fi
}
