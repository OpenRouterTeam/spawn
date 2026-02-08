#!/bin/bash
# Shared bash functions used across all spawn scripts
# Provider-agnostic utilities for logging, input, OAuth, etc.
#
# This file is meant to be sourced by cloud provider-specific common.sh files.
# It does not set bash flags (like set -eo pipefail) as those should be set
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
    echo -e "${GREEN}${1}${NC}" >&2
}

log_warn() {
    echo -e "${YELLOW}${1}${NC}" >&2
}

log_error() {
    echo -e "${RED}${1}${NC}" >&2
}

# ============================================================
# Configurable timing constants
# ============================================================

# Polling interval for OAuth code waiting and other wait loops
# Set SPAWN_POLL_INTERVAL=0.1 for faster testing, or higher for slow networks
POLL_INTERVAL="${SPAWN_POLL_INTERVAL:-1}"

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
    local prompt="${1}"
    local result=""

    if [[ -t 0 ]]; then
        # stdin is a terminal - read directly
        read -p "${prompt}" result
    elif echo -n "" > /dev/tty 2>/dev/null; then
        # /dev/tty is functional - use it
        read -p "${prompt}" result < /dev/tty
    else
        # No interactive input available
        log_error "Cannot read input: no TTY available"
        return 1
    fi

    echo "${result}"
}

# ============================================================
# Network utilities
# ============================================================

# Listen on a port with netcat (handles busybox/Termux nc requiring -p flag)
# Find a working Node.js runtime (bun preferred, then node)
find_node_runtime() {
    if command -v bun &>/dev/null; then echo "bun"; return 0; fi
    if command -v node &>/dev/null; then echo "node"; return 0; fi
    return 1
}

# Open browser to URL (supports macOS, Linux, Termux)
open_browser() {
    local url=${1}
    if command -v termux-open-url &> /dev/null; then
        termux-open-url "${url}" </dev/null
    elif command -v open &> /dev/null; then
        open "${url}" </dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "${url}" </dev/null
    else
        log_warn "Please open: ${url}"
    fi
}

# Validate model ID to prevent command injection
validate_model_id() {
    local model_id="${1}"
    if [[ -z "${model_id}" ]]; then return 0; fi
    if [[ ! "${model_id}" =~ ^[a-zA-Z0-9/_:.-]+$ ]]; then
        log_error "Invalid model ID: contains unsafe characters"
        log_error "Model IDs should only contain: letters, numbers, /, -, _, :, ."
        return 1
    fi
    return 0
}

# Validate server/sprite name to prevent injection and ensure cloud provider compatibility
# Server names must be 3-63 characters, alphanumeric + dash, no leading/trailing dash
validate_server_name() {
    local server_name="${1}"

    if [[ -z "${server_name}" ]]; then
        log_error "Server name cannot be empty"
        return 1
    fi

    # Check length (3-63 characters)
    local name_length=${#server_name}
    if [[ ${name_length} -lt 3 ]]; then
        log_error "Server name too short: '${server_name}' (minimum 3 characters)"
        log_error "Requirements: 3-63 characters, alphanumeric + dash, no leading/trailing dash"
        return 1
    fi

    if [[ ${name_length} -gt 63 ]]; then
        log_error "Server name too long: '${server_name}' (maximum 63 characters)"
        log_error "Requirements: 3-63 characters, alphanumeric + dash, no leading/trailing dash"
        return 1
    fi

    # Check for valid characters (alphanumeric + dash only)
    if [[ ! "${server_name}" =~ ^[a-zA-Z0-9-]+$ ]]; then
        log_error "Invalid server name: '${server_name}'"
        log_error "Server names must contain only alphanumeric characters and dashes"
        log_error "Requirements: 3-63 characters, alphanumeric + dash, no leading/trailing dash"
        return 1
    fi

    # Check no leading dash
    if [[ "${server_name}" =~ ^- ]]; then
        log_error "Invalid server name: '${server_name}'"
        log_error "Server names cannot start with a dash"
        log_error "Requirements: 3-63 characters, alphanumeric + dash, no leading/trailing dash"
        return 1
    fi

    # Check no trailing dash
    if [[ "${server_name}" =~ -$ ]]; then
        log_error "Invalid server name: '${server_name}'"
        log_error "Server names cannot end with a dash"
        log_error "Requirements: 3-63 characters, alphanumeric + dash, no leading/trailing dash"
        return 1
    fi

    return 0
}

# Validate API token to prevent command injection
# Allows alphanumeric, dashes, underscores, and common token separators
# Blocks shell metacharacters: ; ' " < > | & $ ` \ ( )
validate_api_token() {
    local token="${1}"

    if [[ -z "${token}" ]]; then
        log_error "API token cannot be empty"
        return 1
    fi

    # Block shell metacharacters that could enable command injection
    if [[ "${token}" =~ [\;\'\"\<\>\|\&\$\`\\\(\)] ]]; then
        log_error "Invalid token format: contains shell metacharacters"
        log_error "Tokens should not contain: ; ' \" < > | & \$ \` \\ ( )"
        return 1
    fi

    return 0
}

# Validate region/location name (cloud provider regions, datacenters, zones)
# Alphanumeric, hyphens, underscores only, 1-63 chars
validate_region_name() {
    local region="${1}"

    if [[ -z "${region}" ]]; then
        log_error "Region name cannot be empty"
        return 1
    fi

    if [[ ! "${region}" =~ ^[a-zA-Z0-9_-]{1,63}$ ]]; then
        log_error "Invalid region name: '${region}'"
        log_error "Region names must be 1-63 characters: alphanumeric, hyphens, underscores only"
        return 1
    fi

    return 0
}

# Validate resource name (generic: server types, sizes, plans, etc.)
# Alphanumeric, hyphens, underscores, dots, 1-63 chars
validate_resource_name() {
    local name="${1}"

    if [[ -z "${name}" ]]; then
        log_error "Resource name cannot be empty"
        return 1
    fi

    if [[ ! "${name}" =~ ^[a-zA-Z0-9_.-]{1,63}$ ]]; then
        log_error "Invalid resource name: '${name}'"
        log_error "Resource names must be 1-63 characters: alphanumeric, hyphens, underscores, dots only"
        return 1
    fi

    return 0
}

# Validated read wrapper - reads input and validates it with a validator function
# Usage: validated_read "prompt" validator_function_name
# Returns: Validated input via stdout, or exits on error/empty input
# Example: api_key=$(validated_read "Enter API key: " validate_api_token)
validated_read() {
    local prompt="${1}"
    local validator="${2}"
    local value

    while true; do
        value=$(safe_read "${prompt}") || return 1

        if [[ -z "${value}" ]]; then
            return 1
        fi

        if "${validator}" "${value}"; then
            echo "${value}"
            return 0
        fi

        log_warn "Invalid input. Please try again."
    done
}

# Generic function to get resource name from environment or prompt
# Usage: get_resource_name ENV_VAR_NAME PROMPT_TEXT
# Returns: Resource name via stdout
# Example: get_resource_name "LIGHTSAIL_SERVER_NAME" "Enter Lightsail instance name: "
get_resource_name() {
    local env_var_name="${1}"
    local prompt_text="${2}"
    local resource_value="${!env_var_name}"

    if [[ -n "${resource_value}" ]]; then
        log_info "Using ${prompt_text%:*} from environment: ${resource_value}"
        echo "${resource_value}"
        return 0
    fi

    local name
    name=$(safe_read "${prompt_text}")
    if [[ -z "${name}" ]]; then
        log_error "${prompt_text%:*} is required"
        log_warn "Set ${env_var_name} environment variable for non-interactive usage"
        return 1
    fi
    echo "${name}"
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
    if [[ -n "${agent_name}" ]]; then
        log_warn "Which model would you like to use with ${agent_name}?"
    else
        log_warn "Which model would you like to use?"
    fi

    local model_id=""
    model_id=$(safe_read "Enter model ID [${default_model}]: ") || model_id=""
    model_id="${model_id:-${default_model}}"

    if ! validate_model_id "${model_id}"; then
        log_error "Exiting due to invalid model ID"
        return 1
    fi

    echo "${model_id}"
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
    while [[ -z "${api_key}" ]]; do
        api_key=$(safe_read "Enter your OpenRouter API key: ") || return 1

        # Basic validation - OpenRouter keys typically start with "sk-or-"
        if [[ -z "${api_key}" ]]; then
            log_error "API key cannot be empty"
        elif [[ ! "${api_key}" =~ ^sk-or-v1-[a-f0-9]{64}$ ]]; then
            log_warn "Warning: API key format doesn't match expected pattern (sk-or-v1-...)"
            local confirm
            confirm=$(safe_read "Use this key anyway? (y/N): ") || return 1
            if [[ "${confirm}" =~ ^[Yy]$ ]]; then
                break
            else
                api_key=""
            fi
        fi
    done

    log_info "API key accepted!"
    echo "${api_key}"
}

# Start OAuth callback server using Node.js/Bun HTTP server
# Proper HTTP server — handles multiple connections, favicon requests, etc.
# Tries a range of ports if the initial port is busy
# $1=starting_port $2=code_file $3=port_file (writes actual port used)
# Returns: server PID
start_oauth_server() {
    local starting_port="${1}"
    local code_file="${2}"
    local port_file="${3}"
    local runtime
    runtime=$(find_node_runtime) || { log_warn "No Node.js runtime found"; return 1; }

    "${runtime}" -e "
const http = require('http');
const fs = require('fs');
const url = require('url');
const html = '<html><head><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}h1{color:#00d4aa;margin:0 0 8px;font-size:1.6rem}p{margin:0 0 6px;color:#ffffffcc;font-size:1rem}</style></head><body><div class=\"card\"><h1>Authentication Successful!</h1><p>You can close this tab</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>';
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/callback' && parsed.query.code) {
    fs.writeFileSync('${code_file}', parsed.query.code);
    res.writeHead(200, {'Content-Type':'text/html','Connection':'close'});
    res.end(html);
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  } else {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end('<html><body>Waiting for OAuth callback...</body></html>');
  }
});

// Try port range: starting_port, starting_port+1, ..., starting_port+10
let currentPort = ${starting_port};
const maxPort = ${starting_port} + 10;

function tryListen() {
  server.listen(currentPort, '127.0.0.1', () => {
    fs.writeFileSync('${port_file}', currentPort.toString());
    fs.writeFileSync('/dev/fd/1', '');
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && currentPort < maxPort) {
    currentPort++;
    tryListen();
  } else {
    process.exit(1);
  }
});

setTimeout(() => process.exit(0), 300000);
tryListen();
" </dev/null >/dev/null 2>&1 &

    echo $!
}

# Wait for OAuth code with timeout, returns 0 if code received
wait_for_oauth_code() {
    local code_file="${1}"
    local timeout="${2:-120}"
    local elapsed=0

    while [[ ! -f "${code_file}" ]] && [[ ${elapsed} -lt ${timeout} ]]; do
        sleep "${POLL_INTERVAL}"
        elapsed=$((elapsed + POLL_INTERVAL))
    done

    [[ -f "${code_file}" ]]
}

# Exchange OAuth code for API key
exchange_oauth_code() {
    local oauth_code="${1}"

    local key_response
    key_response=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" \
        -d "{\"code\": \"${oauth_code}\"}")

    local api_key
    api_key=$(echo "${key_response}" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')

    if [[ -z "${api_key}" ]]; then
        log_error "Failed to exchange OAuth code: ${key_response}"
        return 1
    fi

    echo "${api_key}"
}

# Clean up OAuth session resources
cleanup_oauth_session() {
    local server_pid="${1}"
    local oauth_dir="${2}"

    if [[ -n "${server_pid}" ]]; then
        kill "${server_pid}" 2>/dev/null || true
        wait "${server_pid}" 2>/dev/null || true
    fi

    if [[ -n "${oauth_dir}" && -d "${oauth_dir}" ]]; then
        rm -rf "${oauth_dir}"
    fi
}

# Check network connectivity to OpenRouter
# Returns 0 if reachable, 1 if network is unreachable
check_openrouter_connectivity() {
    local host="openrouter.ai"
    local port="443"
    local timeout=5

    # Try curl with short timeout if available
    if command -v curl &> /dev/null; then
        if curl -s --connect-timeout "${timeout}" --max-time "${timeout}" "https://${host}" -o /dev/null 2>/dev/null; then
            return 0
        fi
    fi

    # Fallback to nc/telnet test
    if command -v nc &> /dev/null; then
        if timeout "${timeout}" nc -z "${host}" "${port}" 2>/dev/null; then
            return 0
        fi
    elif command -v timeout &> /dev/null && command -v bash &> /dev/null; then
        # Bash TCP socket test as last resort
        if timeout "${timeout}" bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
            return 0
        fi
    fi

    return 1
}

# Try OAuth flow (orchestrates the helper functions above)
try_oauth_flow() {
    local callback_port=${1:-5180}

    log_warn "Attempting OAuth authentication..."

    # Check network connectivity before starting OAuth flow
    if ! check_openrouter_connectivity; then
        log_warn "Cannot reach openrouter.ai - network may be unavailable"
        log_warn "Please check your internet connection and try again"
        return 1
    fi

    local runtime
    runtime=$(find_node_runtime)
    if [[ -z "${runtime}" ]]; then
        log_warn "No Node.js runtime (bun/node) found - OAuth server unavailable"
        return 1
    fi

    local oauth_dir
    oauth_dir=$(mktemp -d)
    local code_file="${oauth_dir}/code"
    local port_file="${oauth_dir}/port"

    log_warn "Starting local OAuth server (trying ports ${callback_port}-$((callback_port + 10)))..."
    local server_pid
    server_pid=$(start_oauth_server "${callback_port}" "${code_file}" "${port_file}")

    sleep "${POLL_INTERVAL}"
    if ! kill -0 "${server_pid}" 2>/dev/null; then
        log_warn "Failed to start OAuth server (all ports in range may be in use)"
        cleanup_oauth_session "" "${oauth_dir}"
        return 1
    fi

    # Wait for port file to be created (server successfully bound to a port)
    local wait_count=0
    while [[ ! -f "${port_file}" ]] && [[ ${wait_count} -lt 10 ]]; do
        sleep 0.2
        wait_count=$((wait_count + 1))
    done

    if [[ ! -f "${port_file}" ]]; then
        log_warn "OAuth server failed to allocate a port"
        cleanup_oauth_session "${server_pid}" "${oauth_dir}"
        return 1
    fi

    local actual_port
    actual_port=$(cat "${port_file}")
    log_info "OAuth server listening on port ${actual_port}"

    local callback_url="http://localhost:${actual_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"

    log_warn "Opening browser to authenticate with OpenRouter..."
    open_browser "${auth_url}"

    if ! wait_for_oauth_code "${code_file}" 120; then
        log_warn "OAuth timeout - no response received"
        cleanup_oauth_session "${server_pid}" "${oauth_dir}"
        return 1
    fi

    local oauth_code
    oauth_code=$(cat "${code_file}")
    cleanup_oauth_session "${server_pid}" "${oauth_dir}"

    log_warn "Exchanging OAuth code for API key..."
    local api_key
    api_key=$(exchange_oauth_code "${oauth_code}") || return 1

    log_info "Successfully obtained OpenRouter API key via OAuth!"
    echo "${api_key}"
}

# Main function: Try OAuth, fallback to manual entry
get_openrouter_api_key_oauth() {
    local callback_port=${1:-5180}

    # Try OAuth flow first
    local api_key
    api_key=$(try_oauth_flow "${callback_port}")

    if [[ -n "${api_key}" ]]; then
        echo "${api_key}"
        return 0
    fi

    # OAuth failed, offer manual entry
    echo ""
    log_warn "OAuth authentication failed or unavailable"
    log_warn "You can enter your API key manually instead"
    echo ""
    local manual_choice
    manual_choice=$(safe_read "Would you like to enter your API key manually? (Y/n): ") || {
        log_error "Cannot prompt for manual entry in non-interactive mode"
        log_warn "Set OPENROUTER_API_KEY environment variable for non-interactive usage"
        return 1
    }

    if [[ ! "${manual_choice}" =~ ^[Nn]$ ]]; then
        api_key=$(get_openrouter_api_key_manual)
        echo "${api_key}"
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
        echo "export ${env_pair}"
    done
}

# Inject environment variables into remote server's shell config (SSH-based clouds)
# Usage: inject_env_vars_ssh SERVER_IP UPLOAD_FUNC RUN_FUNC KEY1=val1 KEY2=val2 ...
# Example: inject_env_vars_ssh "$DO_SERVER_IP" upload_file run_server \
#            "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
#            "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
inject_env_vars_ssh() {
    local server_ip="${1}"
    local upload_func="${2}"
    local run_func="${3}"
    shift 3

    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Upload and append to .zshrc
    "${upload_func}" "${server_ip}" "${env_temp}" "/tmp/env_config"
    "${run_func}" "${server_ip}" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

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
    local temp_file="${1}"
    CLEANUP_TEMP_FILES+=("${temp_file}")
}

# Cleanup function for temporary files
# Called automatically on EXIT, INT, TERM signals
cleanup_temp_files() {
    local exit_code=$?

    for temp_file in "${CLEANUP_TEMP_FILES[@]}"; do
        if [[ -f "${temp_file}" ]]; then
            # Securely remove temp files (may contain credentials)
            shred -f -u "${temp_file}" 2>/dev/null || rm -f "${temp_file}"
        fi
    done

    return ${exit_code}
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
readonly SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${HOME}/.ssh/id_ed25519"

# ============================================================
# SSH key management helpers
# ============================================================

# Generate SSH key if it doesn't exist
# Usage: generate_ssh_key_if_missing KEY_PATH
generate_ssh_key_if_missing() {
    local key_path="${1}"
    if [[ -f "${key_path}" ]]; then
        return 0
    fi
    log_warn "Generating SSH key..."
    mkdir -p "$(dirname "${key_path}")"
    ssh-keygen -t ed25519 -f "${key_path}" -N "" -q
    log_info "SSH key generated at ${key_path}"
}

# Get MD5 fingerprint of SSH public key
# Usage: get_ssh_fingerprint PUB_KEY_PATH
get_ssh_fingerprint() {
    local pub_path="${1}"
    ssh-keygen -lf "${pub_path}" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://'
}

# JSON-escape a string (for embedding in JSON bodies)
# Usage: json_escape STRING
json_escape() {
    local string="${1}"
    python3 -c "import json; print(json.dumps('${string}'))" 2>/dev/null || echo "\"${string}\""
}

# Extract SSH key IDs from cloud provider API response
# Usage: extract_ssh_key_ids API_RESPONSE KEY_FIELD
# KEY_FIELD: "ssh_keys" (DigitalOcean/Vultr) or "data" (Linode)
extract_ssh_key_ids() {
    local api_response="${1}"
    local key_field="${2:-ssh_keys}"
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('${key_field}', [])]
print(json.dumps(ids))
" <<< "${api_response}"
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
  - echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.bashrc
  # Configure PATH in .zshrc
  - echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.zshrc
  # Signal completion
  - touch /root/.cloud-init-complete
CLOUD_INIT_EOF
}

# ============================================================
# Cloud API helpers
# ============================================================

# Generic cloud API wrapper - centralized curl wrapper for all cloud providers
# Includes automatic retry logic with exponential backoff for transient failures
# Usage: generic_cloud_api BASE_URL AUTH_TOKEN METHOD ENDPOINT [BODY] [MAX_RETRIES]
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" POST "/droplets" "$body"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account" "" 5
# Retries on: 429 (rate limit), 503 (service unavailable), network errors
generic_cloud_api() {
    local base_url="${1}"
    local auth_token="${2}"
    local method="${3}"
    local endpoint="${4}"
    local body="${5:-}"
    local max_retries="${6:-3}"

    local attempt=1
    local interval=2
    local max_interval=30

    while [[ "${attempt}" -le "${max_retries}" ]]; do
        local args=(
            -s
            -w "\n%{http_code}"
            -X "${method}"
            -H "Authorization: Bearer ${auth_token}"
            -H "Content-Type: application/json"
        )

        if [[ -n "${body}" ]]; then
            args+=(-d "${body}")
        fi

        local response
        response=$(curl "${args[@]}" "${base_url}${endpoint}" 2>&1)
        local curl_exit_code=$?

        # Extract HTTP status code (last line) and response body (everything else)
        local http_code
        http_code=$(echo "${response}" | tail -1)
        local response_body
        response_body=$(echo "${response}" | head -n -1)

        # Check for network errors (curl exit code != 0)
        if [[ ${curl_exit_code} -ne 0 ]]; then
            if [[ "${attempt}" -ge "${max_retries}" ]]; then
                log_error "Cloud API network error after ${max_retries} attempts: curl exit code ${curl_exit_code}"
                return 1
            fi

            # Calculate next interval with exponential backoff
            local next_interval=$((interval * 2))
            if [[ "${next_interval}" -gt "${max_interval}" ]]; then
                next_interval="${max_interval}"
            fi

            # Add jitter: ±20% randomization
            local jitter
            jitter=$(python3 -c "import random; print(int(${interval} * (0.8 + random.random() * 0.4)))" 2>/dev/null || echo "${interval}")

            log_warn "Cloud API network error (attempt ${attempt}/${max_retries}), retrying in ${jitter}s..."
            sleep "${jitter}"

            interval="${next_interval}"
            attempt=$((attempt + 1))
            continue
        fi

        # Check for transient HTTP errors that should be retried
        if [[ "${http_code}" == "429" ]] || [[ "${http_code}" == "503" ]]; then
            if [[ "${attempt}" -ge "${max_retries}" ]]; then
                log_error "Cloud API returned HTTP ${http_code} after ${max_retries} attempts"
                echo "${response_body}"
                return 1
            fi

            # Calculate next interval with exponential backoff
            local next_interval=$((interval * 2))
            if [[ "${next_interval}" -gt "${max_interval}" ]]; then
                next_interval="${max_interval}"
            fi

            # Add jitter: ±20% randomization
            local jitter
            jitter=$(python3 -c "import random; print(int(${interval} * (0.8 + random.random() * 0.4)))" 2>/dev/null || echo "${interval}")

            local error_msg="rate limit"
            if [[ "${http_code}" == "503" ]]; then
                error_msg="service unavailable"
            fi

            log_warn "Cloud API returned ${error_msg} (HTTP ${http_code}, attempt ${attempt}/${max_retries}), retrying in ${jitter}s..."
            sleep "${jitter}"

            interval="${next_interval}"
            attempt=$((attempt + 1))
            continue
        fi

        # Success or non-retryable error - return response body
        echo "${response_body}"
        return 0
    done

    # Should not reach here, but fail safe
    log_error "Cloud API retry logic exhausted"
    return 1
}

# ============================================================
# Agent verification helpers
# ============================================================

# Verify that an agent is properly installed by checking if its command exists
# Usage: verify_agent_installed AGENT_COMMAND [VERIFICATION_ARG] [ERROR_MESSAGE]
# Examples:
#   verify_agent_installed "claude" "--version" "Claude Code"
#   verify_agent_installed "aider" "--help" "Aider"
#   verify_agent_installed "goose" "--version" "Goose"
# Returns 0 if agent is installed and working, 1 otherwise
verify_agent_installed() {
    local agent_cmd="${1}"
    local verify_arg="${2:---version}"
    local agent_name="${3:-${agent_cmd}}"

    log_warn "Verifying ${agent_name} installation..."

    if ! command -v "${agent_cmd}" &> /dev/null; then
        log_error "${agent_name} installation failed: command '${agent_cmd}' not found in PATH"
        log_error "PATH: ${PATH}"
        return 1
    fi

    if ! "${agent_cmd}" "${verify_arg}" &> /dev/null; then
        log_error "${agent_name} installation failed: '${agent_cmd} ${verify_arg}' returned an error"
        log_error "The command exists but does not execute properly"
        return 1
    fi

    log_info "${agent_name} installation verified successfully"
    return 0
}

# ============================================================
# SSH connectivity helpers
# ============================================================

# Generic SSH wait function - polls until a remote command succeeds with exponential backoff
# Usage: generic_ssh_wait USERNAME IP SSH_OPTS TEST_CMD DESCRIPTION MAX_ATTEMPTS [INITIAL_INTERVAL]
# Implements exponential backoff: starts at INITIAL_INTERVAL (default 5s), doubles up to max 30s
# Adds jitter (±20%) to prevent thundering herd when multiple instances retry simultaneously
generic_ssh_wait() {
    local username="${1}"
    local ip="${2}"
    local ssh_opts="${3}"
    local test_cmd="${4}"
    local description="${5}"
    local max_attempts="${6:-30}"
    local initial_interval="${7:-5}"

    local attempt=1
    local interval="${initial_interval}"
    local max_interval=30
    local elapsed_time=0

    log_warn "Waiting for ${description} to ${ip}..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        if ssh ${ssh_opts} "${username}@${ip}" "${test_cmd}" >/dev/null 2>&1; then
            log_info "${description} ready after ${elapsed_time}s (attempt ${attempt})"
            return 0
        fi

        # Calculate next interval with exponential backoff
        local next_interval=$((interval * 2))
        if [[ "${next_interval}" -gt "${max_interval}" ]]; then
            next_interval="${max_interval}"
        fi

        # Add jitter: ±20% randomization to prevent thundering herd
        # Generates random number between 0.8 and 1.2 times the interval
        local jitter
        jitter=$(python3 -c "import random; print(int(${interval} * (0.8 + random.random() * 0.4)))" 2>/dev/null || echo "${interval}")

        log_warn "Waiting for ${description}... (attempt ${attempt}/${max_attempts}, elapsed ${elapsed_time}s, retry in ${jitter}s)"
        sleep "${jitter}"

        elapsed_time=$((elapsed_time + jitter))
        interval="${next_interval}"
        attempt=$((attempt + 1))
    done

    log_error "${description} failed after ${max_attempts} attempts (${elapsed_time}s elapsed)"
    return 1
}

# Wait for cloud-init to complete on a server
# Usage: wait_for_cloud_init <ip> [max_attempts]
# Default max_attempts is 60 (~5 minutes with exponential backoff)
wait_for_cloud_init() {
    local ip="${1}"
    local max_attempts=${2:-60}
    generic_ssh_wait "root" "${ip}" "${SSH_OPTS}" "test -f /root/.cloud-init-complete" "cloud-init" "${max_attempts}" 5
}

# ============================================================
# API token management helpers
# ============================================================

# Generic ensure API token function - eliminates duplication across providers
# Usage: ensure_api_token_with_provider PROVIDER_NAME ENV_VAR_NAME CONFIG_FILE HELP_URL TEST_FUNC
# Example: ensure_api_token_with_provider "Lambda" "LAMBDA_API_KEY" "$HOME/.config/spawn/lambda.json" \
#            "https://cloud.lambdalabs.com/api-keys" test_lambda_token
# TEST_FUNC should be a function that validates the token and returns 0 on success, 1 on failure
# TEST_FUNC is optional - if empty, no validation is performed
ensure_api_token_with_provider() {
    local provider_name="${1}"
    local env_var_name="${2}"
    local config_file="${3}"
    local help_url="${4}"
    local test_func="${5:-}"

    # Check Python 3 is available (required for JSON parsing)
    check_python_available || return 1

    # 1. Check environment variable
    local env_value="${!env_var_name}"
    if [[ -n "${env_value}" ]]; then
        log_info "Using ${provider_name} API token from environment"
        return 0
    fi

    # 2. Check config file
    if [[ -f "${config_file}" ]]; then
        local saved_token
        saved_token=$(python3 -c "import json; print(json.load(open('${config_file}')).get('api_key','') or json.load(open('${config_file}')).get('token',''))" 2>/dev/null)
        if [[ -n "${saved_token}" ]]; then
            export "${env_var_name}=${saved_token}"
            log_info "Using ${provider_name} API token from ${config_file}"
            return 0
        fi
    fi

    # 3. Prompt and save
    echo ""
    log_warn "${provider_name} API Token Required"
    log_warn "Get your token from: ${help_url}"
    echo ""

    local token
    token=$(validated_read "Enter your ${provider_name} API token: " validate_api_token) || return 1

    # Validate token with provider API if test function provided
    export "${env_var_name}=${token}"
    if [[ -n "${test_func}" ]]; then
        if ! "${test_func}"; then
            log_error "Authentication failed: Invalid ${provider_name} API token"
            unset "${env_var_name}"
            return 1
        fi
    fi

    # Save to config file
    local config_dir
    config_dir=$(dirname "${config_file}")
    mkdir -p "${config_dir}"

    # Save with both "api_key" and "token" for compatibility
    cat > "${config_file}" << EOF
{
  "api_key": "${token}",
  "token": "${token}"
}
EOF
    chmod 600 "${config_file}"
    log_info "API token saved to ${config_file}"
}

# ============================================================
# Claude Code configuration setup
# ============================================================

# Setup Claude Code configuration files (settings.json, .claude.json, CLAUDE.md)
# This consolidates the config setup pattern used by all claude.sh scripts
# Usage: setup_claude_code_config OPENROUTER_KEY UPLOAD_CALLBACK RUN_CALLBACK
#
# Arguments:
#   OPENROUTER_KEY    - OpenRouter API key to inject into config
#   UPLOAD_CALLBACK   - Function to upload files: func(local_path, remote_path)
#   RUN_CALLBACK      - Function to run commands: func(command)
#
# Example (SSH-based clouds):
#   setup_claude_code_config "$OPENROUTER_API_KEY" \
#     "upload_file $SERVER_IP" \
#     "run_server $SERVER_IP"
#
# Example (Sprite):
#   setup_claude_code_config "$OPENROUTER_API_KEY" \
#     "upload_file_sprite $SPRITE_NAME" \
#     "run_sprite $SPRITE_NAME"
setup_claude_code_config() {
    local openrouter_key="${1}"
    local upload_callback="${2}"
    local run_callback="${3}"

    log_warn "Configuring Claude Code..."

    # Create ~/.claude directory
    ${run_callback} "mkdir -p ~/.claude"

    # Create settings.json
    local settings_temp
    settings_temp=$(mktemp)
    chmod 600 "${settings_temp}"
    track_temp_file "${settings_temp}"

    cat > "${settings_temp}" << EOF
{
  "theme": "dark",
  "editor": "vim",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": "${openrouter_key}"
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  }
}
EOF

    ${upload_callback} "${settings_temp}" "/root/.claude/settings.json"

    # Create .claude.json global state
    local global_state_temp
    global_state_temp=$(mktemp)
    chmod 600 "${global_state_temp}"
    track_temp_file "${global_state_temp}"

    cat > "${global_state_temp}" << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF

    ${upload_callback} "${global_state_temp}" "/root/.claude.json"

    # Create empty CLAUDE.md
    ${run_callback} "touch ~/.claude/CLAUDE.md"
}

# ============================================================
# OpenClaw configuration setup
# ============================================================

# Setup OpenClaw configuration files (openclaw.json)
# This consolidates the config setup pattern used by all openclaw.sh scripts
# Usage: setup_openclaw_config OPENROUTER_KEY MODEL_ID UPLOAD_CALLBACK RUN_CALLBACK
#
# Arguments:
#   OPENROUTER_KEY    - OpenRouter API key to inject into config
#   MODEL_ID          - Model ID to use (e.g., "openrouter/auto", "anthropic/claude-3.5-sonnet")
#   UPLOAD_CALLBACK   - Function to upload files: func(local_path, remote_path)
#   RUN_CALLBACK      - Function to run commands: func(command)
#
# Example (SSH-based clouds):
#   setup_openclaw_config "$OPENROUTER_API_KEY" "$MODEL_ID" \
#     "upload_file $SERVER_IP" \
#     "run_server $SERVER_IP"
#
# Example (Sprite):
#   setup_openclaw_config "$OPENROUTER_API_KEY" "$MODEL_ID" \
#     "upload_file_sprite $SPRITE_NAME" \
#     "run_sprite $SPRITE_NAME"
setup_openclaw_config() {
    local openrouter_key="${1}"
    local model_id="${2}"
    local upload_callback="${3}"
    local run_callback="${4}"

    log_warn "Configuring openclaw..."

    # Create ~/.openclaw directory
    ${run_callback} "rm -rf ~/.openclaw && mkdir -p ~/.openclaw"

    # Generate a random gateway token
    local gateway_token
    gateway_token=$(openssl rand -hex 16)

    # Create openclaw.json config
    local config_temp
    config_temp=$(mktemp)
    chmod 600 "${config_temp}"
    track_temp_file "${config_temp}"

    cat > "${config_temp}" << EOF
{
  "env": {
    "OPENROUTER_API_KEY": "${openrouter_key}"
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": "${gateway_token}"
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/${model_id}"
      }
    }
  }
}
EOF

    ${upload_callback} "${config_temp}" "/root/.openclaw/openclaw.json"
}

# ============================================================
# SSH key registration helpers
# ============================================================

# Generic SSH key registration pattern used by all cloud providers
# Eliminates ~220 lines of duplicate code across 5 provider libraries
#
# Usage: ensure_ssh_key_with_provider \
#          CHECK_CALLBACK \
#          REGISTER_CALLBACK \
#          PROVIDER_NAME \
#          [KEY_PATH]
#
# Arguments:
#   CHECK_CALLBACK    - Function that checks if SSH key exists with provider
#                       Should return 0 if key exists, 1 if not
#                       Function receives: fingerprint, pub_key_path
#   REGISTER_CALLBACK - Function that registers SSH key with provider
#                       Should return 0 on success, 1 on error
#                       Function receives: key_name, pub_key_path
#   PROVIDER_NAME     - Display name of the provider (for logging)
#   KEY_PATH          - Optional: Path to SSH private key (default: $HOME/.ssh/id_ed25519)
#
# Example:
#   ensure_ssh_key_with_provider \
#     hetzner_check_ssh_key \
#     hetzner_register_ssh_key \
#     "Hetzner"
#
# Callback implementations should use provider-specific API calls but follow
# this contract to enable shared logic for key generation and registration flow.
ensure_ssh_key_with_provider() {
    local check_callback="${1}"
    local register_callback="${2}"
    local provider_name="${3}"
    local key_path="${4:-${HOME}/.ssh/id_ed25519}"
    local pub_path="${key_path}.pub"

    # Generate key if needed (shared function)
    generate_ssh_key_if_missing "${key_path}"

    # Get fingerprint (shared function)
    local fingerprint
    fingerprint=$(get_ssh_fingerprint "${pub_path}")

    # Check if already registered (provider-specific)
    if "${check_callback}" "${fingerprint}" "${pub_path}"; then
        log_info "SSH key already registered with ${provider_name}"
        return 0
    fi

    # Register the key (provider-specific)
    log_warn "Registering SSH key with ${provider_name}..."
    local key_name
    key_name="spawn-$(hostname)-$(date +%s)"

    if "${register_callback}" "${key_name}" "${pub_path}"; then
        log_info "SSH key registered with ${provider_name}"
        return 0
    else
        log_error "Failed to register SSH key with ${provider_name}"
        return 1
    fi
}
