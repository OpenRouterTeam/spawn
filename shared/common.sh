#!/bin/bash
# shellcheck disable=SC2154
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
    printf '%b\n' "${GREEN}${1}${NC}" >&2
}

log_warn() {
    printf '%b\n' "${YELLOW}${1}${NC}" >&2
}

log_error() {
    printf '%b\n' "${RED}${1}${NC}" >&2
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
        log_error ""
        log_error "Install Python 3:"
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
        read -r -p "${prompt}" result
    elif echo -n "" > /dev/tty 2>/dev/null; then
        # /dev/tty is functional - use it
        read -r -p "${prompt}" result < /dev/tty
    else
        # No interactive input available
        log_error "Cannot prompt for input: no interactive terminal available"
        log_error ""
        log_error "Running in non-interactive mode (pipe, background job, or automated script)."
        log_error "Set required environment variables before running spawn."
        log_error ""
        log_error "Example: OPENROUTER_API_KEY=sk-or-v1-... spawn claude sprite"
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
        log_error "Invalid model ID: '${model_id}'"
        log_error "Model IDs should only contain: letters, numbers, /, -, _, :, ."
        log_error "Browse valid models at: https://openrouter.ai/models"
        return 1
    fi
    return 0
}

# Helper to show server name validation requirements
show_server_name_requirements() {
    log_error "Requirements: 3-63 characters, alphanumeric + dash, no leading/trailing dash"
}

# Validate server/sprite name to prevent injection and ensure cloud provider compatibility
# Server names must be 3-63 characters, alphanumeric + dash, no leading/trailing dash
validate_server_name() {
    local server_name="${1}"

    if [[ -z "${server_name}" ]]; then
        log_error "Server name cannot be empty"
        return 1
    fi

    local name_length=${#server_name}

    # Check length (3-63 characters)
    if [[ ${name_length} -lt 3 ]] || [[ ${name_length} -gt 63 ]]; then
        local constraint
        if [[ ${name_length} -lt 3 ]]; then
            constraint="too short (minimum 3)"
        else
            constraint="too long (maximum 63)"
        fi
        log_error "Server name ${constraint}: '${server_name}'"
        show_server_name_requirements
        return 1
    fi

    # Check for valid characters (alphanumeric + dash only)
    if [[ ! "${server_name}" =~ ^[a-zA-Z0-9-]+$ ]]; then
        log_error "Invalid server name: '${server_name}' (must contain only alphanumeric characters and dashes)"
        show_server_name_requirements
        return 1
    fi

    # Check no leading or trailing dash
    if [[ "${server_name}" =~ ^- ]] || [[ "${server_name}" =~ -$ ]]; then
        log_error "Invalid server name: '${server_name}' (cannot start or end with dash)"
        show_server_name_requirements
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
        log_error "Please provide a valid API token"
        return 1
    fi

    # Block shell metacharacters that could enable command injection
    if [[ "${token}" =~ [\;\'\"\<\>\|\&\$\`\\\(\)] ]]; then
        log_error "Invalid token format: contains shell metacharacters"
        log_error "Tokens should not contain: ; ' \" < > | & \$ \` \\ ( )"
        log_error "Copy the token directly from your provider's dashboard"
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
        log_error "${prompt_text%:*} is required but not provided"
        log_error ""
        log_error "For non-interactive usage, set the environment variable:"
        log_error "  ${env_var_name}=your-value spawn ..."
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
    printf '%b\n' "${YELLOW}Get your API key from: https://openrouter.ai/settings/keys${NC}"
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

# Validate port number for OAuth server
# SECURITY: Prevents injection attacks via port parameter
validate_oauth_port() {
    local port="${1}"

    # Ensure port is a valid integer
    if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
        log_error "Invalid port number: '${port}' (must be numeric)"
        return 1
    fi

    # Ensure port is in valid range (1024-65535, avoiding privileged ports)
    if [[ "${port}" -lt 1024 ]] || [[ "${port}" -gt 65535 ]]; then
        log_error "Invalid port number: ${port} (must be between 1024-65535)"
        return 1
    fi

    return 0
}

# Generate OAuth callback HTML pages (success and error)
# Sets OAUTH_SUCCESS_HTML and OAUTH_ERROR_HTML variables
_generate_oauth_html() {
    local css='body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}h1{margin:0 0 8px;font-size:1.6rem}p{margin:0 0 6px;color:#ffffffcc;font-size:1rem}'
    OAUTH_SUCCESS_HTML="<html><head><style>${css}h1{color:#00d4aa}</style></head><body><div class=\"card\"><h1>Authentication Successful!</h1><p>You can close this tab</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>"
    OAUTH_ERROR_HTML="<html><head><style>${css}h1{color:#d9534f}</style></head><body><div class=\"card\"><h1>Authentication Failed</h1><p>Invalid or missing state parameter (CSRF protection)</p><p>Please try again</p></div></body></html>"
}

# Validate OAuth server prerequisites (port, state token, runtime)
# Sets OAUTH_RUNTIME and OAUTH_STATE variables on success
# $1=starting_port $2=state_file
_validate_oauth_server_args() {
    local starting_port="${1}"
    local state_file="${2}"

    OAUTH_RUNTIME=$(find_node_runtime) || { log_warn "No Node.js runtime found"; return 1; }

    # SECURITY: Validate port number to prevent injection
    if ! validate_oauth_port "${starting_port}"; then
        log_error "OAuth server port validation failed"
        return 1
    fi

    # SECURITY: Read CSRF state token for validation
    OAUTH_STATE=$(cat "${state_file}" 2>/dev/null || echo "")
    if [[ -z "${OAUTH_STATE}" ]]; then
        log_error "CSRF state token file is missing or empty"
        return 1
    fi
}

# Start OAuth callback server using Node.js/Bun HTTP server
# Proper HTTP server — handles multiple connections, favicon requests, etc.
# Tries a range of ports if the initial port is busy
# $1=starting_port $2=code_file $3=port_file (writes actual port used) $4=state_file (CSRF token)
# Returns: server PID
# SECURITY: Validates port number and CSRF state parameter
start_oauth_server() {
    local starting_port="${1}"
    local code_file="${2}"
    local port_file="${3}"
    local state_file="${4}"

    _validate_oauth_server_args "${starting_port}" "${state_file}" || return 1
    local runtime="${OAUTH_RUNTIME}"
    local expected_state="${OAUTH_STATE}"

    _generate_oauth_html
    local oauth_success_html="${OAUTH_SUCCESS_HTML}"
    local oauth_error_html="${OAUTH_ERROR_HTML}"

    "${runtime}" -e "
const http = require('http');
const fs = require('fs');
const url = require('url');
const expectedState = '${expected_state}';
const html = '${oauth_success_html}';
const errorHtml = '${oauth_error_html}';
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/callback' && parsed.query.code) {
    // SECURITY: Validate CSRF state parameter
    if (!parsed.query.state || parsed.query.state !== expectedState) {
      res.writeHead(403, {'Content-Type':'text/html','Connection':'close'});
      res.end(errorHtml);
      setTimeout(() => { server.close(); process.exit(1); }, 500);
      return;
    }
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
// SECURITY: Port number validated in bash before interpolation
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

    log_warn "Waiting for authentication in browser (this usually takes 10-30 seconds, timeout: ${timeout}s)..."
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
    key_response=$(curl -s --max-time 30 -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" \
        -d "{\"code\": \"${oauth_code}\"}")

    local api_key
    api_key=$(echo "${key_response}" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')

    if [[ -z "${api_key}" ]]; then
        log_error "Failed to exchange OAuth code for API key"
        log_warn "Server response: ${key_response}"
        log_warn "This may indicate the OAuth code expired or was already used"
        log_warn "Please try again, or set OPENROUTER_API_KEY manually"
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

# Start OAuth server and wait for it to be ready
# Returns: "port_number" on success, "" on failure (cleanup handled by caller)
start_and_verify_oauth_server() {
    local callback_port="${1}"
    local code_file="${2}"
    local port_file="${3}"
    local state_file="${4}"
    local server_pid="${5}"

    sleep "${POLL_INTERVAL}"
    if ! kill -0 "${server_pid}" 2>/dev/null; then
        log_warn "Failed to start OAuth server - ports ${callback_port}-$((callback_port + 10)) may be in use"
        log_warn "Try closing other dev servers or set OPENROUTER_API_KEY to skip OAuth"
        return 1
    fi

    # Wait for port file to be created (server successfully bound to a port)
    local wait_count=0
    while [[ ! -f "${port_file}" ]] && [[ ${wait_count} -lt 10 ]]; do
        sleep 0.2
        wait_count=$((wait_count + 1))
    done

    if [[ ! -f "${port_file}" ]]; then
        log_warn "OAuth server failed to allocate a port after 2 seconds"
        log_warn "Another process may be using ports ${callback_port}-$((callback_port + 10))"
        return 1
    fi

    cat "${port_file}"
}

# Validate OAuth prerequisites (network, Node.js runtime)
# Returns 0 if all checks pass, 1 otherwise
_check_oauth_prerequisites() {
    if ! check_openrouter_connectivity; then
        log_warn "Cannot reach openrouter.ai - network may be unavailable"
        log_warn "Please check your internet connection and try again"
        log_warn "Alternatively, set OPENROUTER_API_KEY in your environment to skip OAuth"
        return 1
    fi

    local runtime
    runtime=$(find_node_runtime)
    if [[ -z "${runtime}" ]]; then
        log_warn "No Node.js runtime (bun/node) found - required for the OAuth callback server"
        log_warn "Install one with: brew install node  OR  curl -fsSL https://bun.sh/install | bash"
        return 1
    fi

    return 0
}

# Start OAuth server and return actual port, cleanup on failure
# Sets server_pid and returns 0 on success, 1 on failure
_setup_oauth_server() {
    local callback_port="${1}"
    local code_file="${2}"
    local port_file="${3}"
    local state_file="${4}"

    log_warn "Starting local OAuth server (trying ports ${callback_port}-$((callback_port + 10)))..."
    local server_pid
    server_pid=$(start_oauth_server "${callback_port}" "${code_file}" "${port_file}" "${state_file}")

    local actual_port
    actual_port=$(start_and_verify_oauth_server "${callback_port}" "${code_file}" "${port_file}" "${state_file}" "${server_pid}")
    if [[ -z "${actual_port}" ]]; then
        return 1
    fi

    log_info "OAuth server listening on port ${actual_port}"
    echo "${actual_port}"
    return 0
}

# Wait for OAuth code with timeout and cleanup on failure
# Returns 0 on success, 1 on failure
_wait_for_oauth() {
    local code_file="${1}"

    if ! wait_for_oauth_code "${code_file}" 120; then
        log_warn "OAuth timeout - no response received"
        return 1
    fi
    return 0
}

# Try OAuth flow (orchestrates the helper functions above)
# SECURITY: Generates CSRF state token to prevent OAuth code interception
_generate_csrf_state() {
    if command -v openssl &>/dev/null; then
        openssl rand -hex 16
    elif [[ -r /dev/urandom ]]; then
        od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
    else
        # Fallback: use timestamp + random
        printf '%s%04x%04x' "$(date +%s)" $RANDOM $RANDOM
    fi
}

try_oauth_flow() {
    local callback_port=${1:-5180}

    log_warn "Attempting OAuth authentication..."

    # Check prerequisites
    if ! _check_oauth_prerequisites; then
        return 1
    fi

    local oauth_dir
    oauth_dir=$(mktemp -d)
    local code_file="${oauth_dir}/code"
    local port_file="${oauth_dir}/port"
    local state_file="${oauth_dir}/state"

    # SECURITY: Generate random CSRF state token (32 hex chars = 128 bits)
    local csrf_state
    csrf_state=$(_generate_csrf_state)
    echo "${csrf_state}" > "${state_file}"
    chmod 600 "${state_file}"

    # Start server
    local actual_port
    actual_port=$(_setup_oauth_server "${callback_port}" "${code_file}" "${port_file}" "${state_file}") || {
        cleanup_oauth_session "" "${oauth_dir}"
        return 1
    }

    # Get server PID from the port file
    local server_pid
    server_pid=$(pgrep -f "start_oauth_server" | tail -1)

    # Open browser with CSRF state parameter
    local callback_url="http://localhost:${actual_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}&state=${csrf_state}"
    log_warn "Opening browser to authenticate with OpenRouter..."
    open_browser "${auth_url}"

    # Wait for code
    if ! _wait_for_oauth "${code_file}"; then
        cleanup_oauth_session "${server_pid}" "${oauth_dir}"
        log_warn "OAuth timed out after 120 seconds. Common causes:"
        log_warn "  - Browser did not open (try visiting the URL manually)"
        log_warn "  - Authentication was not completed in the browser"
        log_warn "  - Firewall or proxy blocked the local callback on port ${actual_port}"
        return 1
    fi

    local oauth_code
    oauth_code=$(cat "${code_file}")
    cleanup_oauth_session "${server_pid}" "${oauth_dir}"

    # Exchange code for API key
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
    log_warn "OAuth authentication was not completed"
    log_warn "You can enter your API key manually instead"
    log_warn "Get a free key at: https://openrouter.ai/settings/keys"
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
        log_error ""
        log_error "An OpenRouter API key is required to use spawn."
        log_error "Get your free API key at: https://openrouter.ai/settings/keys"
        log_error ""
        log_error "For non-interactive usage, set: OPENROUTER_API_KEY=sk-or-v1-..."
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

# Inject environment variables for providers without SSH (modal, e2b, sprite)
# For providers where upload_file and run_server don't take server_ip as first arg
# Usage: inject_env_vars_local upload_file run_server KEY1=VAL1 KEY2=VAL2 ...
# Example: inject_env_vars_local upload_file run_server \
#            "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
#            "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
inject_env_vars_local() {
    local upload_func="${1}"
    local run_func="${2}"
    shift 2

    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Upload and append to .zshrc
    "${upload_func}" "${env_temp}" "/tmp/env_config"
    "${run_func}" "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

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

    return "${exit_code}"
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
if [[ -z "${SSH_OPTS:-}" ]]; then
    SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${HOME}/.ssh/id_ed25519"
fi

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
    python3 -c "import json, sys; print(json.dumps(sys.stdin.read().rstrip('\n')))" <<< "${string}" 2>/dev/null || {
        # Fallback: manually escape quotes and backslashes
        local escaped="${string//\\/\\\\}"
        escaped="${escaped//\"/\\\"}"
        echo "\"${escaped}\""
    }
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

# Calculate exponential backoff with jitter for retry logic
# Usage: calculate_retry_backoff CURRENT_INTERVAL MAX_INTERVAL
# Returns: backoff interval with ±20% jitter
calculate_retry_backoff() {
    local interval="${1}"
    local max_interval="${2}"

    # Calculate next interval with exponential backoff
    local next_interval=$((interval * 2))
    if [[ "${next_interval}" -gt "${max_interval}" ]]; then
        next_interval="${max_interval}"
    fi

    # Add jitter: ±20% randomization to prevent thundering herd
    python3 -c "import random; print(int(${interval} * (0.8 + random.random() * 0.4)))" 2>/dev/null || echo "${interval}"
}

# Handle API retry decision with backoff - extracted to reduce duplication across API wrappers
# Usage: _api_should_retry_on_error ATTEMPT MAX_RETRIES INTERVAL MAX_INTERVAL MESSAGE
# Returns: 0 to continue/retry, 1 to fail
# Caller updates interval and attempt variables after success
_api_should_retry_on_error() {
    local attempt="${1}"
    local max_retries="${2}"
    local interval="${3}"
    local max_interval="${4}"
    local message="${5}"

    if [[ "${attempt}" -ge "${max_retries}" ]]; then
        return 1  # Don't retry - max attempts exhausted
    fi

    local jitter
    jitter=$(calculate_retry_backoff "${interval}" "${max_interval}")
    log_warn "${message} (attempt ${attempt}/${max_retries}), retrying in ${jitter}s..."
    sleep "${jitter}"

    return 0  # Do retry
}

# Helper to handle transient HTTP error (429 or 503) with retry decision
# Usage: _api_handle_transient_error HTTP_CODE ATTEMPT MAX_RETRIES INTERVAL MAX_INTERVAL
# Returns: 0 to retry, 1 to fail
_api_handle_transient_http_error() {
    local http_code="${1}"
    local attempt="${2}"
    local max_retries="${3}"
    local interval="${4}"
    local max_interval="${5}"

    local error_msg="rate limit"
    if [[ "${http_code}" == "503" ]]; then
        error_msg="service unavailable"
    fi

    if ! _api_should_retry_on_error "http_${http_code}" "${attempt}" "${max_retries}" "${interval}" "${max_interval}" "Cloud API returned ${error_msg} (HTTP ${http_code})"; then
        log_error "Cloud API returned HTTP ${http_code} after ${max_retries} attempts"
        return 1
    fi
    return 0
}

# Helper to update retry interval with backoff
# Usage: _update_retry_interval INTERVAL_VAR MAX_INTERVAL_VAR
# This eliminates repeated interval update logic across API wrappers
_update_retry_interval() {
    local interval_var="${1}"
    local max_interval_var="${2}"

    local current_interval=${!interval_var}
    local max_interval=${!max_interval_var}

    current_interval=$((current_interval * 2))
    if [[ "${current_interval}" -gt "${max_interval}" ]]; then
        current_interval="${max_interval}"
    fi

    printf -v "${interval_var}" '%s' "${current_interval}"
}

# Helper to extract HTTP status code and response body from curl output
# Curl is called with "-w \n%{http_code}" so last line is the code
# Returns: http_code on stdout, response_body via global variable
_parse_api_response() {
    local response="${1}"
    local http_code
    http_code=$(echo "${response}" | tail -1)
    local response_body
    response_body=$(echo "${response}" | sed '$d')

    API_HTTP_CODE="${http_code}"
    API_RESPONSE_BODY="${response_body}"
}

# Helper to handle a single API request attempt - builds curl args and executes it
# Returns: 0 on curl success, 1 on curl failure
# Sets: API_HTTP_CODE and API_RESPONSE_BODY globals
_make_api_request() {
    local base_url="${1}"
    local auth_token="${2}"
    local method="${3}"
    local endpoint="${4}"
    local body="${5:-}"

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

    _parse_api_response "${response}"

    return ${curl_exit_code}
}

# Helper to handle transient API error and decide whether to retry
# Returns: 0 to continue, 1 to fail (response already echoed)
_handle_api_transient_error() {
    local error_type="${1}"  # "network" or HTTP_CODE like "429"
    local attempt="${2}"
    local max_retries="${3}"
    local interval_var="${4}"
    local max_interval_var="${5}"
    local response_body="${6}"

    if [[ "${error_type}" == "network" ]]; then
        if ! _api_should_retry_on_error "network" "${attempt}" "${max_retries}" "${!interval_var}" "${!max_interval_var}" "Cloud API network error"; then
            log_error "Cloud API network error after ${max_retries} attempts"
            return 1
        fi
    else
        # HTTP error code (429 or 503)
        if ! _api_handle_transient_http_error "${error_type}" "${attempt}" "${max_retries}" "${!interval_var}" "${!max_interval_var}"; then
            echo "${response_body}"
            return 1
        fi
    fi

    _update_retry_interval "${interval_var}" "${max_interval_var}"
    return 0
}

# Generic cloud API wrapper - centralized curl wrapper for all cloud providers
# Includes automatic retry logic with exponential backoff for transient failures
# Usage: generic_cloud_api BASE_URL AUTH_TOKEN METHOD ENDPOINT [BODY] [MAX_RETRIES]
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" POST "/droplets" "$body"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account" "" 5
# Retries on: 429 (rate limit), 503 (service unavailable), network errors
# Internal retry loop shared by generic_cloud_api and generic_cloud_api_custom_auth
# Usage: _cloud_api_retry_loop REQUEST_FUNC MAX_RETRIES [REQUEST_FUNC_ARGS...]
_cloud_api_retry_loop() {
    local request_func="${1}"
    local max_retries="${2}"
    shift 2

    local attempt=1
    local interval=2
    local max_interval=30

    while [[ "${attempt}" -le "${max_retries}" ]]; do
        if ! "${request_func}" "$@"; then
            if ! _handle_api_transient_error "network" "${attempt}" "${max_retries}" "interval" "max_interval" ""; then
                return 1
            fi
            attempt=$((attempt + 1))
            continue
        fi

        # Check for transient HTTP errors (429 or 503)
        if [[ "${API_HTTP_CODE}" == "429" ]] || [[ "${API_HTTP_CODE}" == "503" ]]; then
            if ! _handle_api_transient_error "${API_HTTP_CODE}" "${attempt}" "${max_retries}" "interval" "max_interval" "${API_RESPONSE_BODY}"; then
                return 1
            fi
            attempt=$((attempt + 1))
            continue
        fi

        echo "${API_RESPONSE_BODY}"
        return 0
    done

    log_error "Cloud API retry logic exhausted"
    return 1
}

generic_cloud_api() {
    local base_url="${1}"
    local auth_token="${2}"
    local method="${3}"
    local endpoint="${4}"
    local body="${5:-}"
    local max_retries="${6:-3}"

    _cloud_api_retry_loop _make_api_request "${max_retries}" "${base_url}" "${auth_token}" "${method}" "${endpoint}" "${body}"
}

# Helper to make API request with custom curl auth args (e.g., Basic Auth, custom headers)
# Returns: 0 on curl success, 1 on curl failure
# Sets: API_HTTP_CODE and API_RESPONSE_BODY globals
_make_api_request_custom_auth() {
    local url="${1}"
    local method="${2}"
    local body="${3:-}"
    shift 3
    # Remaining args are custom curl auth flags (e.g., -u "user:pass" or -H "X-Auth-Token: ...")

    local args=(
        -s
        -w "\n%{http_code}"
        -X "${method}"
        -H "Content-Type: application/json"
        "$@"
    )

    if [[ -n "${body}" ]]; then
        args+=(-d "${body}")
    fi

    local response
    response=$(curl "${args[@]}" "${url}" 2>&1)
    local curl_exit_code=$?

    _parse_api_response "${response}"

    return ${curl_exit_code}
}

# Generic cloud API wrapper with custom curl auth args
# Like generic_cloud_api but accepts arbitrary curl flags for authentication
# Usage: generic_cloud_api_custom_auth BASE_URL METHOD ENDPOINT BODY MAX_RETRIES AUTH_ARGS...
# Example: generic_cloud_api_custom_auth "$API_BASE" GET "/account" "" 3 -H "X-Auth-Token: $TOKEN"
# Example: generic_cloud_api_custom_auth "$API_BASE" POST "/servers" "$body" 3 -u "$USER:$PASS"
generic_cloud_api_custom_auth() {
    local base_url="${1}"
    local method="${2}"
    local endpoint="${3}"
    local body="${4:-}"
    local max_retries="${5:-3}"
    shift 5
    # Remaining args are custom curl auth flags

    _cloud_api_retry_loop _make_api_request_custom_auth "${max_retries}" "${base_url}${endpoint}" "${method}" "${body}" "$@"
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
        log_error ""
        log_error "Possible causes:"
        log_error "  - The installation script encountered an error (check logs above)"
        log_error "  - Network connectivity issues during download"
        log_error "  - Insufficient disk space or permissions"
        log_error ""
        log_error "Try running the script again, or install ${agent_name} manually."
        return 1
    fi

    if ! "${agent_cmd}" "${verify_arg}" &> /dev/null; then
        log_error "${agent_name} installation failed: '${agent_cmd} ${verify_arg}' returned an error"
        log_error ""
        log_error "The command was installed but doesn't execute properly."
        log_error "Possible causes:"
        log_error "  - Missing runtime dependencies (Python, Node.js, etc.)"
        log_error "  - Incompatible system architecture or OS version"
        log_error "  - Corrupted download or partial installation"
        log_error ""
        log_error "Try running the script again, or check ${agent_name}'s installation docs."
        return 1
    fi

    log_info "${agent_name} installation verified successfully"
    return 0
}

# ============================================================
# Non-interactive agent execution
# ============================================================

# Execute an agent in non-interactive mode with a prompt
# Usage: execute_agent_non_interactive SPRITE_NAME AGENT_NAME AGENT_FLAGS PROMPT
# Arguments:
#   SPRITE_NAME    - Name of the sprite/server to execute on
#   AGENT_NAME     - Name of the agent command (e.g., "claude", "aider")
#   AGENT_FLAGS    - Agent-specific flags for non-interactive execution (e.g., "-p" for claude, "-m" for aider)
#   PROMPT         - User prompt to execute
#   EXEC_CALLBACK  - Function to execute commands: func(sprite_name, command)
#
# Example (Sprite):
#   execute_agent_non_interactive "$SPRITE_NAME" "claude" "-p" "$PROMPT" "sprite_exec"
#
# Example (SSH):
#   execute_agent_non_interactive "$SERVER_IP" "aider" "-m" "$PROMPT" "ssh_exec"
execute_agent_non_interactive() {
    local sprite_name="${1}"
    local agent_name="${2}"
    local agent_flags="${3}"
    local prompt="${4}"
    local exec_callback="${5}"

    log_info "Executing ${agent_name} with prompt in non-interactive mode..."

    # Escape the prompt for safe shell execution
    # We use printf %q which properly escapes special characters for bash
    local escaped_prompt
    escaped_prompt=$(printf '%q' "${prompt}")

    # Build the command based on exec callback type
    if [[ "${exec_callback}" == *"sprite"* ]]; then
        # Sprite execution (no -tty flag for non-interactive)
        sprite exec -s "${sprite_name}" -- zsh -c "source ~/.zshrc && ${agent_name} ${agent_flags} ${escaped_prompt}"
    else
        # Generic SSH execution
        ${exec_callback} "${sprite_name}" "source ~/.zshrc && ${agent_name} ${agent_flags} ${escaped_prompt}"
    fi
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

    log_warn "Waiting for ${description} to ${ip} (this usually takes 30-90 seconds)..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        # shellcheck disable=SC2086
        if ssh ${ssh_opts} "${username}@${ip}" "${test_cmd}" >/dev/null 2>&1; then
            log_info "${description} ready after ${elapsed_time}s (attempt ${attempt})"
            return 0
        fi

        # Calculate next interval with exponential backoff and jitter
        local jitter
        jitter=$(calculate_retry_backoff "${interval}" "${max_interval}")

        log_warn "Waiting for ${description}... (attempt ${attempt}/${max_attempts}, elapsed ${elapsed_time}s, retry in ${jitter}s)"
        sleep "${jitter}"

        elapsed_time=$((elapsed_time + jitter))
        interval=$((interval * 2))
        if [[ "${interval}" -gt "${max_interval}" ]]; then
            interval="${max_interval}"
        fi
        attempt=$((attempt + 1))
    done

    log_error "${description} failed after ${max_attempts} attempts (${elapsed_time}s elapsed)"
    log_warn "The server at ${ip} may still be booting. You can try again or check its status in your cloud provider dashboard."
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

# Try to load API token from environment variable
# Returns 0 if found and sets env var, 1 otherwise
_load_token_from_env() {
    local env_var_name="${1}"
    local provider_name="${2}"

    local env_value="${!env_var_name}"
    if [[ -n "${env_value}" ]]; then
        log_info "Using ${provider_name} API token from environment"
        return 0
    fi
    return 1
}

# Try to load API token from config file
# Returns 0 if found and exports env var, 1 otherwise
_load_token_from_config() {
    local config_file="${1}"
    local env_var_name="${2}"
    local provider_name="${3}"

    if [[ ! -f "${config_file}" ]]; then
        return 1
    fi

    local saved_token
    saved_token=$(python3 -c "import json, sys; data=json.load(open(sys.argv[1])); print(data.get('api_key','') or data.get('token',''))" "${config_file}" 2>/dev/null)
    if [[ -z "${saved_token}" ]]; then
        return 1
    fi

    export "${env_var_name}=${saved_token}"
    log_info "Using ${provider_name} API token from ${config_file}"
    return 0
}

# Validate token with provider API if test function provided
# Returns 0 on success, 1 on validation failure
_validate_token_with_provider() {
    local test_func="${1}"
    local env_var_name="${2}"
    local provider_name="${3}"

    if [[ -z "${test_func}" ]]; then
        return 0  # No validation needed
    fi

    if ! "${test_func}"; then
        log_error "Authentication failed: Invalid ${provider_name} API token"
        unset "${env_var_name}"
        return 1
    fi
    return 0
}

# Save API token to config file
_save_token_to_config() {
    local config_file="${1}"
    local token="${2}"

    local config_dir
    config_dir=$(dirname "${config_file}")
    mkdir -p "${config_dir}"

    cat > "${config_file}" << EOF
{
  "api_key": "${token}",
  "token": "${token}"
}
EOF
    chmod 600 "${config_file}"
    log_info "API token saved to ${config_file}"
}

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

    check_python_available || return 1

    # Try environment variable
    if _load_token_from_env "${env_var_name}" "${provider_name}"; then
        return 0
    fi

    # Try config file
    if _load_token_from_config "${config_file}" "${env_var_name}" "${provider_name}"; then
        return 0
    fi

    # Prompt for new token
    echo ""
    log_warn "${provider_name} API Token Required"
    log_warn "Get your token from: ${help_url}"
    echo ""

    local token
    token=$(validated_read "Enter your ${provider_name} API token: " validate_api_token) || return 1

    export "${env_var_name}=${token}"

    # Validate with provider API
    if ! _validate_token_with_provider "${test_func}" "${env_var_name}" "${provider_name}"; then
        return 1
    fi

    # Save to config file
    _save_token_to_config "${config_file}" "${token}"
    return 0
}

# ============================================================
# Configuration file helpers
# ============================================================

# Helper to create, upload, and install a config file from a heredoc or string
# Usage: upload_config_file UPLOAD_CALLBACK RUN_CALLBACK CONTENT REMOTE_PATH
# Example: upload_config_file "$upload_func" "$run_func" "$json_content" "~/.config/app.json"
upload_config_file() {
    local upload_callback="${1}"
    local run_callback="${2}"
    local content="${3}"
    local remote_path="${4}"

    local temp_file
    temp_file=$(mktemp)
    chmod 600 "${temp_file}"
    track_temp_file "${temp_file}"

    printf '%s\n' "${content}" > "${temp_file}"

    local temp_remote="/tmp/spawn_config_$$_$(basename "${remote_path}")"
    ${upload_callback} "${temp_file}" "${temp_remote}"
    ${run_callback} "mv ${temp_remote} ${remote_path}"
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
    local settings_json
    settings_json=$(printf '{\n  "theme": "dark",\n  "editor": "vim",\n  "env": {\n    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",\n    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",\n    "ANTHROPIC_AUTH_TOKEN": %s\n  },\n  "permissions": {\n    "defaultMode": "bypassPermissions",\n    "dangerouslySkipPermissions": true\n  }\n}\n' "$(json_escape "${openrouter_key}")")
    upload_config_file "${upload_callback}" "${run_callback}" "${settings_json}" "~/.claude/settings.json"

    # Create .claude.json global state
    local global_state_json
    global_state_json=$(cat << EOF
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true
}
EOF
)
    upload_config_file "${upload_callback}" "${run_callback}" "${global_state_json}" "~/.claude.json"

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
    local openclaw_json
    openclaw_json=$(printf '{\n  "env": {\n    "OPENROUTER_API_KEY": %s\n  },\n  "gateway": {\n    "mode": "local",\n    "auth": {\n      "token": %s\n    }\n  },\n  "agents": {\n    "defaults": {\n      "model": {\n        "primary": "openrouter/%s"\n      }\n    }\n  }\n}\n' "$(json_escape "${openrouter_key}")" "$(json_escape "${gateway_token}")" "${model_id}")
    upload_config_file "${upload_callback}" "${run_callback}" "${openclaw_json}" "~/.openclaw/openclaw.json"
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

# ============================================================
# Agent install commands (run remotely on provisioned servers)
# ============================================================

# Robust OpenCode install command that downloads to a file first instead of
# piping curl|tar, which breaks in container exec environments (Sprite, E2B,
# Modal, Daytona) where the binary stream can get corrupted through the exec
# layer. The upstream installer's "curl -#" flag also interferes in non-TTY
# environments.
opencode_install_cmd() {
    printf '%s' 'OC_ARCH=$(uname -m); if [ "$OC_ARCH" = "aarch64" ]; then OC_ARCH=arm64; fi; OC_OS=$(uname -s | tr A-Z a-z); if [ "$OC_OS" = "darwin" ]; then OC_OS=mac; fi; mkdir -p /tmp/opencode-install "$HOME/.opencode/bin" && curl -fsSL -o /tmp/opencode-install/oc.tar.gz "https://github.com/opencode-ai/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz" && tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install && mv /tmp/opencode-install/opencode "$HOME/.opencode/bin/" && rm -rf /tmp/opencode-install && grep -q ".opencode/bin" "$HOME/.bashrc" 2>/dev/null || echo '"'"'export PATH="$HOME/.opencode/bin:$PATH"'"'"' >> "$HOME/.bashrc"; grep -q ".opencode/bin" "$HOME/.zshrc" 2>/dev/null || echo '"'"'export PATH="$HOME/.opencode/bin:$PATH"'"'"' >> "$HOME/.zshrc" 2>/dev/null; export PATH="$HOME/.opencode/bin:$PATH"'
}

# ============================================================
# Auto-initialization
# ============================================================

# Auto-register cleanup trap when this file is sourced
register_cleanup_trap
