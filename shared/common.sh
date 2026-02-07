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
# Dependency checks
# ============================================================

# Check if Python 3 is available (required for JSON parsing throughout Spawn)
check_python_available() {
    if ! command -v python3 &> /dev/null; then
        log_error "Python 3 is required but not installed"
        log_error ""
        log_error "Spawn uses Python 3 for JSON parsing and API interactions."
        log_error "Please install Python 3 before continuing:"
        log_error ""
        log_error "  Ubuntu/Debian:  sudo apt-get update && sudo apt-get install -y python3"
        log_error "  Fedora/RHEL:    sudo dnf install -y python3"
        log_error "  macOS:          brew install python3"
        log_error "  Arch Linux:     sudo pacman -S python"
        log_error ""
        return 1
    fi
    return 0
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

# Interactively prompt for model ID with validation
# Usage: get_model_id_interactive [default_model] [agent_name]
# Returns: Model ID via stdout
# Example: MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider")
get_model_id_interactive() {
    local default_model="${1:-openrouter/auto}"
    local agent_name="${2:-}"

    echo ""
    log_warn "Browse models at: https://openrouter.ai/models"
    if [[ -n "$agent_name" ]]; then
        log_warn "Which model would you like to use with $agent_name?"
    else
        log_warn "Which model would you like to use?"
    fi

    local model_id=""
    model_id=$(safe_read "Enter model ID [$default_model]: ") || model_id=""
    model_id="${model_id:-$default_model}"

    if ! validate_model_id "$model_id"; then
        log_error "Exiting due to invalid model ID"
        return 1
    fi

    echo "$model_id"
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

# Generate OAuth success response HTML
create_oauth_response_html() {
    cat << 'HTML_EOF'
HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><style>@keyframes checkmark{0%{transform:scale(0) rotate(-45deg);opacity:0}60%{transform:scale(1.2) rotate(-45deg);opacity:1}100%{transform:scale(1) rotate(-45deg);opacity:1}}@keyframes fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}.check{width:80px;height:80px;border-radius:50%;background:#00d4aa22;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.check::after{content:"";display:block;width:28px;height:14px;border-left:4px solid #00d4aa;border-bottom:4px solid #00d4aa;animation:checkmark .5s ease forwards}h1{color:#00d4aa;margin:0 0 8px;font-size:1.6rem}p{margin:0 0 6px;color:#ffffffcc;font-size:1rem}.sub{color:#ffffff66;font-size:.85rem;animation:fadein .5s ease .5s both}</style></head><body><div class="card"><div class="check"></div><h1>Authentication Successful!</h1><p>Redirecting back to terminal...</p><p class="sub">This tab will close automatically</p></div><script>setTimeout(function(){try{window.close()}catch(e){}setTimeout(function(){document.querySelector(".sub").textContent="You can safely close this tab"},500)},3000)</script></body></html>
HTML_EOF
}

# Start OAuth callback server in background, returns server PID
start_oauth_server() {
    local port="$1"
    local code_file="$2"
    local success_response=$(create_oauth_response_html)

    (
        while true; do
            local response_file=$(mktemp)
            echo -e "$success_response" > "$response_file"

            local request=$(nc_listen "$port" < "$response_file" 2>/dev/null | head -1)
            local nc_status=$?
            rm -f "$response_file"

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

    echo $!
}

# Wait for OAuth code with timeout, returns 0 if code received
wait_for_oauth_code() {
    local code_file="$1"
    local timeout="${2:-120}"
    local elapsed=0

    while [[ ! -f "$code_file" ]] && [[ $elapsed -lt $timeout ]]; do
        sleep 1
        ((elapsed++))
    done

    [[ -f "$code_file" ]]
}

# Exchange OAuth code for API key
exchange_oauth_code() {
    local oauth_code="$1"

    local key_response=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" \
        -d "{\"code\": \"$oauth_code\"}")

    local api_key=$(echo "$key_response" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')

    if [[ -z "$api_key" ]]; then
        log_error "Failed to exchange OAuth code: ${key_response}"
        return 1
    fi

    echo "$api_key"
}

# Clean up OAuth session resources
cleanup_oauth_session() {
    local server_pid="$1"
    local oauth_dir="$2"

    if [[ -n "$server_pid" ]]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi

    if [[ -n "$oauth_dir" && -d "$oauth_dir" ]]; then
        rm -rf "$oauth_dir"
    fi
}

# Try OAuth flow (orchestrates the helper functions above)
try_oauth_flow() {
    local callback_port=${1:-5180}

    log_warn "Attempting OAuth authentication..."

    if ! command -v nc &> /dev/null; then
        log_warn "netcat (nc) not found - OAuth server unavailable"
        return 1
    fi

    local callback_url="http://localhost:${callback_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"
    local oauth_dir=$(mktemp -d)
    local code_file="$oauth_dir/code"

    log_warn "Starting local OAuth server on port ${callback_port}..."
    local server_pid=$(start_oauth_server "$callback_port" "$code_file")

    sleep 1
    if ! kill -0 "$server_pid" 2>/dev/null; then
        log_warn "Failed to start OAuth server (port may be in use)"
        cleanup_oauth_session "" "$oauth_dir"
        return 1
    fi

    log_warn "Opening browser to authenticate with OpenRouter..."
    open_browser "$auth_url"

    if ! wait_for_oauth_code "$code_file" 120; then
        log_warn "OAuth timeout - no response received"
        cleanup_oauth_session "$server_pid" "$oauth_dir"
        return 1
    fi

    local oauth_code=$(cat "$code_file")
    cleanup_oauth_session "$server_pid" "$oauth_dir"

    log_warn "Exchanging OAuth code for API key..."
    local api_key=$(exchange_oauth_code "$oauth_code") || return 1

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

# ============================================================
# Environment injection helpers
# ============================================================

# Generate environment variable config content
# Usage: generate_env_config KEY1=val1 KEY2=val2 ...
# Outputs the env config to stdout
generate_env_config() {
    echo ""
    echo "# [spawn:env]"
    for env_pair in "$@"; do
        echo "export $env_pair"
    done
}

# Inject environment variables into remote server's shell config (SSH-based clouds)
# Usage: inject_env_vars_ssh SERVER_IP UPLOAD_FUNC RUN_FUNC KEY1=val1 KEY2=val2 ...
# Example: inject_env_vars_ssh "$DO_SERVER_IP" upload_file run_server \
#            "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
#            "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
inject_env_vars_ssh() {
    local server_ip="$1"
    local upload_func="$2"
    local run_func="$3"
    shift 3

    local env_temp=$(mktemp)
    chmod 600 "$env_temp"
    track_temp_file "$env_temp"

    generate_env_config "$@" > "$env_temp"

    # Upload and append to .zshrc
    "$upload_func" "$server_ip" "$env_temp" "/tmp/env_config"
    "$run_func" "$server_ip" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

    # Note: temp file will be cleaned up by trap handler
}

# ============================================================
# Resource cleanup trap handlers
# ============================================================

# Array to track temporary files for cleanup
CLEANUP_TEMP_FILES=()

# Track a temporary file for cleanup on exit
# Usage: track_temp_file PATH
track_temp_file() {
    local temp_file="$1"
    CLEANUP_TEMP_FILES+=("$temp_file")
}

# Cleanup function for temporary files
# Called automatically on EXIT, INT, TERM signals
cleanup_temp_files() {
    local exit_code=$?

    for temp_file in "${CLEANUP_TEMP_FILES[@]}"; do
        if [[ -f "$temp_file" ]]; then
            # Securely remove temp files (may contain credentials)
            shred -f -u "$temp_file" 2>/dev/null || rm -f "$temp_file"
        fi
    done

    return $exit_code
}

# Register cleanup trap handler
# Call this at the start of scripts that create temp files
register_cleanup_trap() {
    trap cleanup_temp_files EXIT INT TERM
}

# ============================================================
# SSH configuration
# ============================================================

# Default SSH options for all cloud providers
# Clouds can override this if they need provider-specific settings
readonly SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

# ============================================================
# SSH key management helpers
# ============================================================

# Generate SSH key if it doesn't exist
# Usage: generate_ssh_key_if_missing KEY_PATH
generate_ssh_key_if_missing() {
    local key_path="$1"
    if [[ -f "$key_path" ]]; then
        return 0
    fi
    log_warn "Generating SSH key..."
    mkdir -p "$(dirname "$key_path")"
    ssh-keygen -t ed25519 -f "$key_path" -N "" -q
    log_info "SSH key generated at $key_path"
}

# Get MD5 fingerprint of SSH public key
# Usage: get_ssh_fingerprint PUB_KEY_PATH
get_ssh_fingerprint() {
    local pub_path="$1"
    ssh-keygen -lf "$pub_path" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://'
}

# JSON-escape a string (for embedding in JSON bodies)
# Usage: json_escape STRING
json_escape() {
    local string="$1"
    python3 -c "import json; print(json.dumps('$string'))" 2>/dev/null || echo "\"$string\""
}

# Extract SSH key IDs from cloud provider API response
# Usage: extract_ssh_key_ids API_RESPONSE KEY_FIELD
# KEY_FIELD: "ssh_keys" (DigitalOcean/Vultr) or "data" (Linode)
extract_ssh_key_ids() {
    local api_response="$1"
    local key_field="${2:-ssh_keys}"
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('$key_field', [])]
print(json.dumps(ids))
" <<< "$api_response"
}

# ============================================================
# Cloud provisioning helpers
# ============================================================

# Generate cloud-init userdata YAML for server provisioning
# This is the default userdata used by all cloud providers
# Clouds can override this function if they need provider-specific cloud-init config
get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#cloud-config
package_update: true
packages:
  - curl
  - unzip
  - git
  - zsh

runcmd:
  # Install Bun
  - su - root -c 'curl -fsSL https://bun.sh/install | bash'
  # Install Claude Code
  - su - root -c 'curl -fsSL https://claude.ai/install.sh | bash'
  # Configure PATH in .bashrc
  - echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /root/.bashrc
  # Configure PATH in .zshrc
  - echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /root/.zshrc
  # Signal completion
  - touch /root/.cloud-init-complete
CLOUD_INIT_EOF
}

# ============================================================
# Cloud API helpers
# ============================================================

# Generic cloud API wrapper - centralized curl wrapper for all cloud providers
# Usage: generic_cloud_api BASE_URL AUTH_TOKEN METHOD ENDPOINT [BODY]
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" POST "/droplets" "$body"
generic_cloud_api() {
    local base_url="$1"
    local auth_token="$2"
    local method="$3"
    local endpoint="$4"
    local body="${5:-}"

    local args=(
        -s
        -X "$method"
        -H "Authorization: Bearer ${auth_token}"
        -H "Content-Type: application/json"
    )

    if [[ -n "$body" ]]; then
        args+=(-d "$body")
    fi

    curl "${args[@]}" "${base_url}${endpoint}"
}

# ============================================================
# SSH connectivity helpers
# ============================================================

# Generic SSH wait function - polls until a remote command succeeds
# Usage: generic_ssh_wait IP SSH_OPTS TEST_CMD DESCRIPTION MAX_ATTEMPTS INTERVAL
generic_ssh_wait() {
    local ip="$1"
    local ssh_opts="$2"
    local test_cmd="$3"
    local description="$4"
    local max_attempts="${5:-30}"
    local interval="${6:-5}"
    local attempt=1

    log_warn "Waiting for $description to $ip..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        if ssh $ssh_opts "root@$ip" "$test_cmd" >/dev/null 2>&1; then
            log_info "$description ready"
            return 0
        fi
        log_warn "Waiting for $description... ($attempt/$max_attempts)"
        sleep "$interval"
        ((attempt++))
    done

    log_error "$description failed after $max_attempts attempts"
    return 1
}
