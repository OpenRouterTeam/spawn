#!/bin/bash
# Common bash functions shared between spawn scripts

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Print colored message (to stderr so they don't pollute command substitution output)
log_info() {
    echo -e "${GREEN}$1${NC}" >&2
}

log_warn() {
    echo -e "${YELLOW}$1${NC}" >&2
}

log_error() {
    echo -e "${RED}$1${NC}" >&2
}

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

# Check if sprite CLI is installed, install if not
ensure_sprite_installed() {
    if ! command -v sprite &> /dev/null; then
        log_warn "Installing sprite CLI..."
        curl -fsSL https://sprites.dev/install.sh | bash
        export PATH="$HOME/.local/bin:$PATH"
    fi
}

# Check if already authenticated with sprite
ensure_sprite_authenticated() {
    if ! sprite org list &> /dev/null; then
        log_warn "Logging in to sprite..."
        sprite login || true
    fi
}

# Prompt for sprite name
get_sprite_name() {
    # Check if SPRITE_NAME is already set in environment
    if [[ -n "$SPRITE_NAME" ]]; then
        log_info "Using sprite name from environment: $SPRITE_NAME"
        echo "$SPRITE_NAME"
        return 0
    fi

    # Try to read interactively
    local sprite_name=$(safe_read "Enter sprite name: ")
    if [[ -z "$sprite_name" ]]; then
        log_error "Sprite name is required"
        log_warn "Set SPRITE_NAME environment variable for non-interactive usage:"
        log_warn "  SPRITE_NAME=dev-mk1 curl ... | bash"
        return 1
    fi

    echo "$sprite_name"
}

# Check if sprite exists, create if not
ensure_sprite_exists() {
    local sprite_name=$1
    local sleep_time=${2:-3}

    if sprite list 2>/dev/null | grep -qE "^${sprite_name}( |$)"; then
        log_info "Sprite '$sprite_name' already exists"
    else
        log_warn "Creating sprite '$sprite_name'..."
        sprite create -skip-console "$sprite_name" || true
        log_warn "Waiting for sprite to be ready..."
        sleep "$sleep_time"
    fi
}

# Verify sprite is accessible
verify_sprite_connectivity() {
    local sprite_name=$1
    log_warn "Verifying sprite connectivity..."
    if ! sprite exec -s "$sprite_name" -- echo "ok" >/dev/null 2>&1; then
        log_warn "Sprite not ready, waiting longer..."
        sleep 5
    fi
}

# Helper function to run commands on sprite
run_sprite() {
    local sprite_name=$1
    local command=$2
    sprite exec -s "$sprite_name" -- bash -c "$command"
}

# Configure shell environment (PATH, zsh setup)
setup_shell_environment() {
    local sprite_name=$1
    log_warn "Configuring shell environment..."

    # Create temp file with path config
    local path_temp=$(mktemp)
    cat > "$path_temp" << 'EOF'

# [spawn:path]
export PATH="$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH"
EOF

    # Upload and append to shell configs
    sprite exec -s "$sprite_name" -file "$path_temp:/tmp/path_config" -- bash -c "cat /tmp/path_config >> ~/.zprofile && cat /tmp/path_config >> ~/.zshrc && rm /tmp/path_config"
    rm "$path_temp"

    # Switch bash to zsh
    local bash_temp=$(mktemp)
    cat > "$bash_temp" << 'EOF'
# [spawn:bash]
exec /usr/bin/zsh -l
EOF

    sprite exec -s "$sprite_name" -file "$bash_temp:/tmp/bash_config" -- bash -c "cat /tmp/bash_config > ~/.bash_profile && cat /tmp/bash_config > ~/.bashrc && rm /tmp/bash_config"
    rm "$bash_temp"
}

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
        local success_response='HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e;"><div style="text-align: center; color: #fff;"><h1 style="color: #00d4aa;">Authentication Successful!</h1><p>You can close this window and return to your terminal.</p></div></body></html>'

        while true; do
            # Listen and capture just the first line of the request, then respond
            local response_file=$(mktemp)
            echo -e "$success_response" > "$response_file"

            local request=$(nc -l "$callback_port" < "$response_file" 2>/dev/null | head -1)
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
    if ! kill -0 $server_pid 2>/dev/null; then
        log_warn "Failed to start OAuth server (port may be in use)"
        rm -rf "$oauth_dir"
        return 1
    fi

    # Open browser
    log_warn "Opening browser to authenticate with OpenRouter..."
    if command -v open &> /dev/null; then
        open "$auth_url" </dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$auth_url" </dev/null
    else
        log_warn "Please open: ${auth_url}"
    fi

    # Wait for the code file to be created (timeout after 2 minutes)
    local timeout=120
    local elapsed=0
    while [[ ! -f "$code_file" ]] && [[ $elapsed -lt $timeout ]]; do
        sleep 1
        ((elapsed++))
    done

    # Kill the background server process
    kill $server_pid 2>/dev/null || true
    wait $server_pid 2>/dev/null || true

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

# Open browser to URL
open_browser() {
    local url=$1
    if command -v open &> /dev/null; then
        open "$url" </dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$url" </dev/null
    else
        log_warn "Please open: ${url}"
    fi
}
