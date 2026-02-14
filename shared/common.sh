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
CYAN='\033[0;36m'
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

# Progress/status messages (use instead of log_warn for non-warning status updates)
log_step() {
    printf '%b\n' "${CYAN}${1}${NC}" >&2
}

# Print a structured diagnostic: header, possible causes, and how-to-fix steps.
# Arguments: HEADER CAUSE... --- FIX...
# The literal "---" separates causes from fixes.
_log_diagnostic() {
    local header="${1}"; shift
    log_error "${header}"
    log_error ""
    log_error "Possible causes:"
    while [[ $# -gt 0 && "${1}" != "---" ]]; do
        log_error "  - ${1}"; shift
    done
    if [[ $# -gt 0 ]]; then
        shift  # skip ---
        log_error ""
        log_error "How to fix:"
        local i=1
        while [[ $# -gt 0 ]]; do
            log_error "  ${i}. ${1}"; shift
            i=$((i + 1))
        done
    fi
}

# Log actionable guidance when agent installation verification fails.
# Usage: log_install_failed AGENT_NAME [INSTALL_CMD] [SERVER_IP]
# Example: log_install_failed "Claude Code" "curl -fsSL https://claude.ai/install.sh | bash" "$IP"
log_install_failed() {
    local agent_name="${1}"
    local install_cmd="${2:-}"
    local server_ip="${3:-}"

    log_error "${agent_name} installation failed to complete successfully"
    log_error ""
    log_error "The agent could not be installed or verified on the server."
    log_error ""
    log_error "Common causes:"
    log_error "  - Network timeout downloading packages (npm, pip, etc.)"
    log_error "  - Insufficient disk space or memory on the server"
    log_error "  - Missing system dependencies for ${agent_name}"
    log_error "  - Cloud provider's package mirror is temporarily unavailable"
    log_error ""
    log_error "Debugging steps:"
    if [[ -n "${server_ip}" ]]; then
        log_error "  1. SSH into the server and check logs:"
        log_error "     ssh root@${server_ip}"
        log_error "     Check: df -h  (disk space)"
        log_error "     Check: free -h  (memory)"
    fi
    if [[ -n "${install_cmd}" ]]; then
        log_error "  2. Try the installation manually:"
        log_error "     ${install_cmd}"
    fi
    log_error "  3. Re-run spawn to try on a fresh server (some failures are transient)"
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

# Install jq if not already present (required by some cloud providers)
# Platform-specific jq install helpers
_install_jq_brew() {
    if command -v brew &>/dev/null; then
        brew install jq || { log_error "Failed to install jq via Homebrew. Run 'brew install jq' manually."; return 1; }
    else
        log_error "jq is required but not installed"
        log_error "Install it with: brew install jq"
        log_error "If Homebrew is not available: https://jqlang.github.io/jq/download/"
        return 1
    fi
}

_install_jq_apt() {
    sudo apt-get update -qq && sudo apt-get install -y jq || {
        log_error "Failed to install jq via apt. Run 'sudo apt-get install -y jq' manually."
        return 1
    }
}

_install_jq_dnf() {
    sudo dnf install -y jq || {
        log_error "Failed to install jq via dnf. Run 'sudo dnf install -y jq' manually."
        return 1
    }
}

_install_jq_apk() {
    sudo apk add jq || {
        log_error "Failed to install jq via apk. Run 'sudo apk add jq' manually."
        return 1
    }
}

_report_jq_not_found() {
    log_error "jq is required but not installed"
    log_error ""
    log_error "Install jq for your system:"
    log_error "  Ubuntu/Debian:  sudo apt-get install -y jq"
    log_error "  Fedora/RHEL:    sudo dnf install -y jq"
    log_error "  macOS:          brew install jq"
    log_error "  Other:          https://jqlang.github.io/jq/download/"
}

ensure_jq() {
    if command -v jq &>/dev/null; then
        return 0
    fi

    log_step "Installing jq..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        _install_jq_brew || return 1
    elif command -v apt-get &>/dev/null; then
        _install_jq_apt || return 1
    elif command -v dnf &>/dev/null; then
        _install_jq_dnf || return 1
    elif command -v apk &>/dev/null; then
        _install_jq_apk || return 1
    else
        _report_jq_not_found
        return 1
    fi

    if ! command -v jq &>/dev/null; then
        log_error "jq was installed but is not found in PATH"
        log_error "Try opening a new terminal or run: hash -r"
        return 1
    fi

    log_info "jq installed"
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
        read -r -p "${prompt}" result || return 1
    elif echo -n "" > /dev/tty 2>/dev/null; then
        # /dev/tty is functional - use it
        read -r -p "${prompt}" result < /dev/tty || return 1
    else
        # No interactive input available
        log_error "Cannot prompt for input: no interactive terminal available"
        log_error ""
        log_error "You're running spawn in non-interactive mode (piped input, background job, or CI/CD)."
        log_error "Set all required environment variables before launching spawn."
        log_error ""
        log_error "Example:"
        log_error "  export OPENROUTER_API_KEY=sk-or-v1-..."
        log_error "  export CLOUD_API_TOKEN=..."
        log_error "  spawn <agent> <cloud>"
        log_error ""
        log_error "Or use inline variables:"
        log_error "  OPENROUTER_API_KEY=sk-or-v1-... spawn <agent> <cloud>"
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
        log_step "Please open: ${url}"
    fi
}

# Validate model ID to prevent command injection
validate_model_id() {
    local model_id="${1}"
    if [[ -z "${model_id}" ]]; then return 0; fi
    if [[ ! "${model_id}" =~ ^[a-zA-Z0-9/_:.-]+$ ]]; then
        log_error "Invalid model ID: '${model_id}'"
        log_error ""
        log_error "Model IDs can only contain:"
        log_error "  - Letters (a-z, A-Z)"
        log_error "  - Numbers (0-9)"
        log_error "  - Special characters: / - _ : ."
        log_error ""
        log_error "Examples of valid model IDs:"
        log_error "  - anthropic/claude-3.5-sonnet"
        log_error "  - openai/gpt-4-turbo"
        log_error "  - openrouter/auto"
        log_error ""
        log_error "Browse all models at: https://openrouter.ai/models"
        return 1
    fi
    return 0
}

# Helper to show server name validation requirements
show_server_name_requirements() {
    log_error ""
    log_error "Server name requirements:"
    log_error "  - Length: 3-63 characters"
    log_error "  - Characters: letters (a-z, A-Z), numbers (0-9), dashes (-)"
    log_error "  - No leading or trailing dashes"
    log_error ""
    log_error "Examples of valid names:"
    log_error "  - my-server"
    log_error "  - dev-box-01"
    log_error "  - spawn-agent"
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
        log_error "Invalid token format: contains special characters"
        log_error "API tokens should only contain letters, numbers, dashes, and underscores."
        log_error "Copy the token directly from your provider's dashboard without extra characters."
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

        log_warn "Please try again."
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

# Get server name from environment or prompt, with validation
# Usage: get_validated_server_name ENV_VAR_NAME PROMPT_TEXT
# Returns: Validated server name via stdout
# Example: get_validated_server_name "HETZNER_SERVER_NAME" "Enter server name: "
get_validated_server_name() {
    local server_name
    server_name=$(get_resource_name "$1" "$2") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Interactively prompt for model ID with validation
# Usage: get_model_id_interactive [default_model] [agent_name]
# Returns: Model ID via stdout
# Example: MODEL_ID=$(get_model_id_interactive "openrouter/auto" "Aider")
get_model_id_interactive() {
    local default_model="${1:-openrouter/auto}"
    local agent_name="${2:-}"

    # If MODEL_ID is already set in the environment, validate and use it without prompting
    if [[ -n "${MODEL_ID:-}" ]]; then
        if ! validate_model_id "${MODEL_ID}"; then
            log_error "MODEL_ID environment variable contains invalid characters"
            return 1
        fi
        echo "${MODEL_ID}"
        return 0
    fi

    echo "" >&2
    log_info "Browse models at: https://openrouter.ai/models"
    if [[ -n "${agent_name}" ]]; then
        log_info "Which model would you like to use with ${agent_name}?"
    else
        log_info "Which model would you like to use?"
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
    log_info "Manual API Key Entry"
    printf '%b\n' "${GREEN}Get your API key from: https://openrouter.ai/settings/keys${NC}"
    echo ""

    local api_key=""
    local attempts=0
    local max_attempts=3
    while [[ -z "${api_key}" ]]; do
        attempts=$((attempts + 1))
        if [[ ${attempts} -gt ${max_attempts} ]]; then
            log_error "Too many failed attempts."
            log_error ""
            log_error "How to fix:"
            log_error "  1. Get your key from: https://openrouter.ai/settings/keys"
            log_error "  2. Set it before running spawn: export OPENROUTER_API_KEY=sk-or-v1-..."
            log_error "  3. Then re-run: spawn <agent> <cloud>"
            return 1
        fi
        api_key=$(safe_read "Enter your OpenRouter API key: ") || return 1

        # Basic validation - OpenRouter keys typically start with "sk-or-"
        if [[ -z "${api_key}" ]]; then
            log_error "API key cannot be empty"
        elif [[ ! "${api_key}" =~ ^sk-or-v1-[a-f0-9]{64}$ ]]; then
            log_warn "This doesn't look like an OpenRouter API key (expected format: sk-or-v1-...)"
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

# Generate the Node.js script for the OAuth callback server
# $1=expected_state $2=success_html $3=error_html $4=code_file $5=port_file $6=starting_port
_generate_oauth_server_script() {
    local expected_state="${1}" success_html="${2}" error_html="${3}"
    local code_file="${4}" port_file="${5}" starting_port="${6}"
    printf '%s' "
const http = require('http');
const fs = require('fs');
const url = require('url');
const expectedState = '${expected_state}';
const html = '${success_html}';
const errorHtml = '${error_html}';
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/callback' && parsed.query.code) {
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
"
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

    _generate_oauth_html
    local script
    script=$(_generate_oauth_server_script "${OAUTH_STATE}" "${OAUTH_SUCCESS_HTML}" "${OAUTH_ERROR_HTML}" \
        "${code_file}" "${port_file}" "${starting_port}")

    "${OAUTH_RUNTIME}" -e "${script}" </dev/null >/dev/null 2>&1 &

    echo $!
}

# Wait for OAuth code with timeout, returns 0 if code received
wait_for_oauth_code() {
    local code_file="${1}"
    local timeout="${2:-120}"
    local elapsed=0

    log_step "Waiting for authentication in browser (this usually takes 10-30 seconds, timeout: ${timeout}s)..."
    while [[ ! -f "${code_file}" ]] && [[ ${elapsed} -lt ${timeout} ]]; do
        sleep "${POLL_INTERVAL}"
        elapsed=$((elapsed + POLL_INTERVAL))
    done

    [[ -f "${code_file}" ]]
}

# Exchange OAuth code for API key
exchange_oauth_code() {
    local oauth_code="${1}"

    # SECURITY: Use json_escape to prevent JSON injection via crafted OAuth codes
    local escaped_code
    escaped_code=$(json_escape "${oauth_code}")

    local key_response
    key_response=$(curl -s --max-time 30 -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" \
        -d "{\"code\": ${escaped_code}}")

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

    log_step "Starting local OAuth server (trying ports ${callback_port}-$((callback_port + 10)))..."
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
        log_error "Cannot generate secure CSRF token: neither openssl nor /dev/urandom available"
        log_error "Install openssl or ensure /dev/urandom is readable"
        return 1
    fi
}

# Create temp directory with OAuth session files and CSRF state
_init_oauth_session() {
    local oauth_dir
    oauth_dir=$(mktemp -d)

    # SECURITY: Generate random CSRF state token (32 hex chars = 128 bits)
    local csrf_state
    csrf_state=$(_generate_csrf_state)
    printf '%s' "${csrf_state}" > "${oauth_dir}/state"
    chmod 600 "${oauth_dir}/state"

    echo "${oauth_dir}"
}

# Open browser and wait for OAuth callback, returning the auth code
# Outputs the OAuth code on success, returns 1 on timeout
_await_oauth_callback() {
    local code_file="${1}"
    local server_pid="${2}"
    local oauth_dir="${3}"
    local actual_port="${4}"
    local csrf_state="${5}"

    local callback_url="http://localhost:${actual_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}&state=${csrf_state}"
    log_step "Opening browser to authenticate with OpenRouter..."
    open_browser "${auth_url}"

    if ! _wait_for_oauth "${code_file}"; then
        cleanup_oauth_session "${server_pid}" "${oauth_dir}"
        log_error "OAuth authentication timed out after 120 seconds"
        log_error ""
        log_error "The authentication flow was not completed in time."
        log_error ""
        log_error "Troubleshooting:"
        log_error "  1. Check if your browser opened to openrouter.ai"
        log_error "  2. Complete the authentication and allow the redirect"
        log_error "  3. Ensure port ${actual_port} is not blocked by firewall/proxy"
        log_error ""
        log_error "Alternative: Use a manual API key instead"
        log_error "  export OPENROUTER_API_KEY=sk-or-v1-..."
        log_error "  Get a key at: https://openrouter.ai/settings/keys"
        return 1
    fi

    cat "${code_file}"
}

try_oauth_flow() {
    local callback_port=${1:-5180}

    log_step "Attempting OAuth authentication..."

    if ! _check_oauth_prerequisites; then
        return 1
    fi

    local oauth_dir
    oauth_dir=$(_init_oauth_session)
    local code_file="${oauth_dir}/code"
    local csrf_state
    csrf_state=$(cat "${oauth_dir}/state")

    # Start server
    local actual_port
    actual_port=$(_setup_oauth_server "${callback_port}" "${code_file}" "${oauth_dir}/port" "${oauth_dir}/state") || {
        cleanup_oauth_session "" "${oauth_dir}"
        return 1
    }

    local server_pid
    server_pid=$(pgrep -f "start_oauth_server" | tail -1)

    # Open browser and wait for callback
    local oauth_code
    oauth_code=$(_await_oauth_callback "${code_file}" "${server_pid}" "${oauth_dir}" "${actual_port}" "${csrf_state}") || return 1
    cleanup_oauth_session "${server_pid}" "${oauth_dir}"

    # Exchange code for API key
    log_step "Exchanging OAuth code for API key..."
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
    log_warn "Browser-based OAuth login was not completed."
    log_warn "This is normal on remote servers, SSH sessions, or headless environments."
    log_info "You can paste an API key instead. Create one at: https://openrouter.ai/settings/keys"
    echo ""
    local manual_choice
    manual_choice=$(safe_read "Paste your API key manually? (Y/n): ") || {
        log_error "Cannot prompt for manual entry in non-interactive mode"
        log_warn "Set OPENROUTER_API_KEY environment variable before running spawn"
        return 1
    }

    if [[ "${manual_choice}" =~ ^[Nn]$ ]]; then
        log_error "Authentication cancelled. An OpenRouter API key is required to use spawn."
        log_warn "To authenticate, either:"
        log_warn "  - Re-run this command and complete the OAuth flow in your browser"
        log_warn "  - Set OPENROUTER_API_KEY=sk-or-v1-... before running spawn"
        log_warn "  - Create a key at: https://openrouter.ai/settings/keys"
        return 1
    fi

    api_key=$(get_openrouter_api_key_manual)
    echo "${api_key}"
}

# ============================================================
# Environment injection helpers
# ============================================================

# Generate environment variable config content
# Usage: generate_env_config KEY1=val1 KEY2=val2 ...
# Outputs the env config to stdout
# SECURITY: Values are single-quoted to prevent shell injection when sourced.
# Single quotes prevent all interpretation of special characters ($, `, \, etc.)
generate_env_config() {
    echo ""
    echo "# [spawn:env]"
    # All spawn environments are disposable cloud VMs — mark as sandbox
    echo "export IS_SANDBOX='1'"
    for env_pair in "$@"; do
        local key="${env_pair%%=*}"
        local value="${env_pair#*=}"
        # Escape any single quotes in the value: replace ' with '\''
        local escaped_value="${value//\'/\'\\\'\'}"
        echo "export ${key}='${escaped_value}'"
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

# Validate SSH_OPTS to prevent command injection
# Only allow safe SSH option patterns (dash-prefixed flags and values)
_validate_ssh_opts() {
    local opts="${1}"
    # Allow empty
    if [[ -z "${opts}" ]]; then
        return 0
    fi
    # Pattern: SSH opts must start with dash and contain only safe characters
    # Allows: -o Option=value -i /path/to/key -p 22 etc.
    # Blocks: semicolons, pipes, backticks, $() and other shell metacharacters
    if [[ "${opts}" =~ [\;\|\&\`\$\(\)\<\>] ]]; then
        log_error "SECURITY: SSH_OPTS contains shell metacharacters"
        log_error "Rejected value: ${opts}"
        return 1
    fi
    return 0
}

# Default SSH options for all cloud providers
# Clouds can override this if they need provider-specific settings
if [[ -z "${SSH_OPTS:-}" ]]; then
    SSH_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${HOME}/.ssh/id_ed25519"
else
    # Validate user-provided SSH_OPTS for security
    if ! _validate_ssh_opts "${SSH_OPTS}"; then
        log_error "Invalid SSH_OPTS provided. Using secure defaults."
        SSH_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i ${HOME}/.ssh/id_ed25519"
    fi
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
    log_step "Generating SSH key at ${key_path}..."
    mkdir -p "$(dirname "${key_path}")" || {
        log_error "Failed to create SSH key directory: $(dirname "${key_path}")"
        log_error "Check that you have write permissions to this directory."
        return 1
    }
    ssh-keygen -t ed25519 -f "${key_path}" -N "" -q || {
        log_error "Failed to generate SSH key at ${key_path}"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Check disk space: df -h $(dirname "${key_path}")"
        log_error "  2. Check permissions: ls -la $(dirname "${key_path}")"
        log_error "  3. Generate manually: ssh-keygen -t ed25519 -f ${key_path}"
        return 1
    }
    log_info "SSH key generated at ${key_path}"
}

# Get MD5 fingerprint of SSH public key
# Usage: get_ssh_fingerprint PUB_KEY_PATH
get_ssh_fingerprint() {
    local pub_path="${1}"
    if [[ ! -f "${pub_path}" ]]; then
        log_error "SSH public key not found: ${pub_path}"
        log_error "Expected a public key file alongside your private key."
        log_error "Regenerate with: ssh-keygen -t ed25519 -f ${pub_path%.pub}"
        return 1
    fi
    local fingerprint
    fingerprint=$(ssh-keygen -lf "${pub_path}" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://')
    if [[ -z "${fingerprint}" ]]; then
        log_error "Failed to read SSH public key fingerprint from ${pub_path}"
        log_error "The key file may be corrupted or in an unsupported format."
        log_error "Regenerate with: ssh-keygen -t ed25519 -f ${pub_path%.pub}"
        return 1
    fi
    echo "${fingerprint}"
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
  # Mark as sandbox environment (disposable cloud VM)
  - echo 'export IS_SANDBOX=1' >> /root/.bashrc
  - echo 'export IS_SANDBOX=1' >> /root/.zshrc
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

# Core curl wrapper for API requests - builds args, executes, parses response
# Usage: _curl_api URL METHOD BODY AUTH_ARGS...
# Returns: 0 on curl success, 1 on curl failure
# Sets: API_HTTP_CODE and API_RESPONSE_BODY globals
_curl_api() {
    local url="${1}"
    local method="${2}"
    local body="${3:-}"
    shift 3

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

# Helper to handle a single API request attempt with Bearer auth
# Returns: 0 on curl success, 1 on curl failure
# Sets: API_HTTP_CODE and API_RESPONSE_BODY globals
_make_api_request() {
    local base_url="${1}"
    local auth_token="${2}"
    local method="${3}"
    local endpoint="${4}"
    local body="${5:-}"

    _curl_api "${base_url}${endpoint}" "${method}" "${body}" -H "Authorization: Bearer ${auth_token}"
}

# Generic cloud API wrapper - centralized curl wrapper for all cloud providers
# Includes automatic retry logic with exponential backoff for transient failures
# Usage: generic_cloud_api BASE_URL AUTH_TOKEN METHOD ENDPOINT [BODY] [MAX_RETRIES]
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" POST "/droplets" "$body"
# Example: generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" GET "/account" "" 5
# Retries on: 429 (rate limit), 503 (service unavailable), network errors
# Internal retry loop shared by generic_cloud_api and generic_cloud_api_custom_auth
# Usage: _cloud_api_retry_loop REQUEST_FUNC MAX_RETRIES API_DESCRIPTION [REQUEST_FUNC_ARGS...]
# Classify the result of an API request attempt.
# Returns a retry reason string on stdout if the request failed with a retryable error,
# or empty string on success. Caller checks the return string.
_classify_api_result() {
    local curl_ok="${1}"
    if [[ "${curl_ok}" != "0" ]]; then
        echo "Cloud API network error"
    elif [[ "${API_HTTP_CODE}" == "429" ]]; then
        echo "Cloud API returned rate limit (HTTP 429)"
    elif [[ "${API_HTTP_CODE}" == "503" ]]; then
        echo "Cloud API returned service unavailable (HTTP 503)"
    fi
}

# Report a final API failure after retries are exhausted
_report_api_failure() {
    local retry_reason="${1}"
    local max_retries="${2}"
    log_error "${retry_reason} after ${max_retries} attempts"
    if [[ "${retry_reason}" == "Cloud API network error" ]]; then
        log_warn "Could not reach the cloud provider's API."
        log_warn ""
        log_warn "How to fix:"
        log_warn "  1. Check your internet connection: curl -s https://httpbin.org/ip"
        log_warn "  2. Check DNS resolution: nslookup the provider's API hostname"
        log_warn "  3. If behind a proxy or firewall, ensure HTTPS traffic is allowed"
        log_warn "  4. Try again in a few moments (the API may be temporarily down)"
    else
        log_warn "This is usually caused by rate limiting or temporary provider issues."
        log_warn "Wait a minute and try again, or check the provider's status page."
        echo "${API_RESPONSE_BODY}"
    fi
}

_cloud_api_retry_loop() {
    local request_func="${1}"
    local max_retries="${2}"
    local api_description="${3}"
    shift 3

    local attempt=1
    local interval=2
    local max_interval=30

    while [[ "${attempt}" -le "${max_retries}" ]]; do
        local curl_ok=0
        "${request_func}" "$@" || curl_ok=$?

        local retry_reason
        retry_reason=$(_classify_api_result "${curl_ok}")

        if [[ -z "${retry_reason}" ]]; then
            echo "${API_RESPONSE_BODY}"
            return 0
        fi

        if ! _api_should_retry_on_error "${attempt}" "${max_retries}" "${interval}" "${max_interval}" "${retry_reason}"; then
            _report_api_failure "${retry_reason}" "${max_retries}"
            return 1
        fi
        _update_retry_interval interval max_interval
        attempt=$((attempt + 1))
    done

    log_error "Cloud API request failed after ${max_retries} attempts (${api_description})"
    log_warn "This is usually caused by rate limiting or temporary provider issues."
    log_warn "Wait a minute and try again, or check the provider's status page."
    return 1
}

generic_cloud_api() {
    local base_url="${1}"
    local auth_token="${2}"
    local method="${3}"
    local endpoint="${4}"
    local body="${5:-}"
    local max_retries="${6:-3}"

    _cloud_api_retry_loop _make_api_request "${max_retries}" "${method} ${endpoint}" "${base_url}" "${auth_token}" "${method}" "${endpoint}" "${body}"
}

# Helper to make API request with custom curl auth args (e.g., Basic Auth, custom headers)
# Returns: 0 on curl success, 1 on curl failure
# Sets: API_HTTP_CODE and API_RESPONSE_BODY globals
_make_api_request_custom_auth() {
    local url="${1}"
    local method="${2}"
    local body="${3:-}"
    shift 3

    _curl_api "${url}" "${method}" "${body}" "$@"
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

    _cloud_api_retry_loop _make_api_request_custom_auth "${max_retries}" "${method} ${endpoint}" "${base_url}${endpoint}" "${method}" "${body}" "$@"
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

    log_step "Verifying ${agent_name} installation..."

    if ! command -v "${agent_cmd}" &> /dev/null; then
        _log_diagnostic \
            "${agent_name} installation failed: command '${agent_cmd}' not found in PATH" \
            "The installation script encountered an error (check logs above)" \
            "The binary was installed to a directory not in PATH" \
            "Network issues prevented the download from completing" \
            --- \
            "Re-run the script to retry the installation" \
            "Install ${agent_name} manually and ensure it is in PATH"
        return 1
    fi

    if ! "${agent_cmd}" "${verify_arg}" &> /dev/null; then
        _log_diagnostic \
            "${agent_name} verification failed: '${agent_cmd} ${verify_arg}' returned an error" \
            "Missing runtime dependencies (Python, Node.js, etc.)" \
            "Incompatible system architecture or OS version" \
            --- \
            "Check ${agent_name}'s installation docs for prerequisites" \
            "Run '${agent_cmd} ${verify_arg}' manually to see the error"
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

    log_step "Executing ${agent_name} with prompt in non-interactive mode..."

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
# Log progress message based on elapsed time
_log_ssh_wait_progress() {
    local description="${1}"
    local elapsed_time="${2}"

    if [[ ${elapsed_time} -lt 60 ]]; then
        log_step "Waiting for ${description}... (${elapsed_time}s elapsed, still within normal range)"
    elif [[ ${elapsed_time} -lt 120 ]]; then
        log_step "Waiting for ${description}... (${elapsed_time}s elapsed, taking longer than usual)"
    else
        log_warn "Still waiting for ${description}... (${elapsed_time}s elapsed, this is unusually slow)"
    fi
}

# Log timeout error message with troubleshooting steps
_log_ssh_wait_timeout_error() {
    local description="${1}"
    local elapsed_time="${2}"
    local username="${3}"
    local ip="${4}"

    log_error "${description} timed out after ${elapsed_time}s (server: ${ip})"
    log_error ""
    log_error "The server failed to become ready within the expected timeframe."
    log_error ""
    log_error "Common causes:"
    log_error "  - Server is still booting (some cloud providers take 2-3 minutes)"
    log_error "  - Cloud provider API delays or maintenance"
    log_error "  - Firewall blocking SSH on port 22"
    log_error "  - Network connectivity issues"
    log_error ""
    log_error "Troubleshooting steps:"
    log_error "  1. Test SSH manually:  ssh ${username}@${ip}"
    log_error "  2. Check firewall rules in your cloud provider dashboard"
    if [[ -n "${SPAWN_DASHBOARD_URL:-}" ]]; then
        log_error "     Dashboard: ${SPAWN_DASHBOARD_URL}"
    fi
    log_error "  3. Re-run this command to retry (the server may need more time)"
    if [[ -n "${SPAWN_RETRY_CMD:-}" ]]; then
        log_error "     ${SPAWN_RETRY_CMD}"
    fi
}

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

    log_step "Waiting for ${description} to ${ip} (this usually takes 30-90 seconds)..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        # shellcheck disable=SC2086
        if ssh ${ssh_opts} "${username}@${ip}" "${test_cmd}" >/dev/null 2>&1; then
            log_info "${description} ready (took ${elapsed_time}s)"
            return 0
        fi

        local jitter
        jitter=$(calculate_retry_backoff "${interval}" "${max_interval}")

        _log_ssh_wait_progress "${description}" "${elapsed_time}"
        sleep "${jitter}"

        elapsed_time=$((elapsed_time + jitter))
        _update_retry_interval interval max_interval
        attempt=$((attempt + 1))
    done

    _log_ssh_wait_timeout_error "${description}" "${elapsed_time}" "${username}" "${ip}"
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
# Standard SSH server operations
# ============================================================

# Most SSH-based cloud providers share identical implementations for
# run_server, upload_file, interactive_session, and verify_server_connectivity.
# These helpers let providers set SSH_USER (default: root) and get all four
# functions automatically, eliminating ~20 lines of copy-paste per provider.

# Run a command on a remote server via SSH
# Usage: ssh_run_server IP COMMAND
# Requires: SSH_USER (default: root), SSH_OPTS
# SECURITY: Command is properly quoted to prevent shell injection
ssh_run_server() {
    local ip="${1}"
    local cmd="${2}"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "${SSH_USER:-root}@${ip}" -- "${cmd}"
}

# Upload a file to a remote server via SCP
# Usage: ssh_upload_file IP LOCAL_PATH REMOTE_PATH
# Requires: SSH_USER (default: root), SSH_OPTS
ssh_upload_file() {
    local ip="${1}"
    local local_path="${2}"
    local remote_path="${3}"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "${local_path}" "${SSH_USER:-root}@${ip}:${remote_path}"
}

# Show a post-session summary reminding the user their server is still running.
# Called automatically by ssh_interactive_session after the SSH session ends.
# Uses optional env vars for richer output:
#   SPAWN_DASHBOARD_URL - Cloud provider dashboard URL for managing servers
#   SERVER_NAME         - Server name (set by individual cloud scripts)
# Arguments: IP
_show_post_session_summary() {
    local ip="${1}"
    local dashboard_url="${SPAWN_DASHBOARD_URL:-}"
    local server_name="${SERVER_NAME:-}"

    printf '\n'
    if [[ -n "${server_name}" ]]; then
        log_warn "Session ended. Your server '${server_name}' is still running at ${ip}."
    else
        log_warn "Session ended. Your server is still running at ${ip}."
    fi
    log_warn "Remember to delete it when you're done to avoid ongoing charges."
    log_warn ""
    if [[ -n "${dashboard_url}" ]]; then
        log_warn "Manage or delete it in your dashboard:"
        log_warn "  ${dashboard_url}"
    else
        log_warn "Check your cloud provider dashboard to stop or delete the server."
    fi
    log_warn ""
    log_info "To reconnect:"
    log_info "  ssh ${SSH_USER:-root}@${ip}"
}

# Show a post-session summary for exec-based (non-SSH) cloud providers.
# These use CLI exec commands instead of direct SSH, so the reconnect
# hint differs from the SSH variant.
# Uses optional env vars for richer output:
#   SPAWN_DASHBOARD_URL  - Cloud provider dashboard URL for managing services
#   SERVER_NAME          - Service/sandbox name
#   SPAWN_RECONNECT_CMD  - CLI command to reconnect (shown as reconnect hint)
_show_exec_post_session_summary() {
    local dashboard_url="${SPAWN_DASHBOARD_URL:-}"
    local server_name="${SERVER_NAME:-}"
    local reconnect_cmd="${SPAWN_RECONNECT_CMD:-}"

    printf '\n'
    if [[ -n "${server_name}" ]]; then
        log_warn "Session ended. Your service '${server_name}' is still running."
    else
        log_warn "Session ended. Your service is still running."
    fi
    log_warn "Remember to delete it when you're done to avoid ongoing charges."
    log_warn ""
    if [[ -n "${dashboard_url}" ]]; then
        log_warn "Manage or delete it in your dashboard:"
        log_warn "  ${dashboard_url}"
    else
        log_warn "Check your cloud provider dashboard to stop or delete the service."
    fi
    if [[ -n "${reconnect_cmd}" ]]; then
        log_warn ""
        log_info "To reconnect:"
        log_info "  ${reconnect_cmd}"
    fi
}

# Start an interactive SSH session
# Usage: ssh_interactive_session IP COMMAND
# Requires: SSH_USER (default: root), SSH_OPTS
# SECURITY: Command is properly quoted to prevent shell injection
ssh_interactive_session() {
    local ip="${1}"
    local cmd="${2}"
    local ssh_exit=0
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "${SSH_USER:-root}@${ip}" -- "${cmd}" || ssh_exit=$?
    _show_post_session_summary "${ip}"
    return "${ssh_exit}"
}

# Wait for SSH connectivity to a server
# Usage: ssh_verify_connectivity IP [MAX_ATTEMPTS] [INITIAL_INTERVAL]
# Requires: SSH_USER (default: root), SSH_OPTS
ssh_verify_connectivity() {
    local ip="${1}"
    local max_attempts=${2:-30}
    local initial_interval=${3:-5}
    # shellcheck disable=SC2154
    generic_ssh_wait "${SSH_USER:-root}" "${ip}" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "${max_attempts}" "${initial_interval}"
}

# Extract a value from a JSON response using a Python expression
# Usage: _extract_json_field JSON_STRING PYTHON_EXPR [DEFAULT]
# The Python expression receives 'd' as the parsed JSON dict.
# Returns DEFAULT (or empty string) on parse failure.
_extract_json_field() {
    local json="${1}"
    local py_expr="${2}"
    local default="${3:-}"

    printf '%s' "${json}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(${py_expr})" 2>/dev/null || echo "${default}"
}

# Extract an error message from a JSON API response.
# Tries common error field patterns used by cloud provider APIs:
#   message, error, error.message, error.error_message, reason
# Falls back to the raw response if no known field matches.
# Usage: extract_api_error_message JSON_STRING [FALLBACK]
extract_api_error_message() {
    local json="${1}"
    local fallback="${2:-Unknown error}"

    printf '%s' "${json}" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    e = d.get('error', '')
    msg = (
        (isinstance(e, dict) and (e.get('message') or e.get('error_message')))
        or d.get('message')
        or d.get('reason')
        or (isinstance(e, str) and e)
        or ''
    )
    if msg:
        print(msg)
    else:
        sys.exit(1)
except:
    sys.exit(1)
" 2>/dev/null || echo "${fallback}"
}

# Generic instance status polling loop
# Polls an API endpoint until the instance reaches the target status, then extracts the IP.
# Usage: generic_wait_for_instance API_FUNC ENDPOINT TARGET_STATUS STATUS_PY IP_PY IP_VAR DESCRIPTION [MAX_ATTEMPTS]
#
# Arguments:
#   API_FUNC       - Cloud API function name (e.g., "vultr_api", "do_api")
#   ENDPOINT       - API endpoint path (e.g., "/instances/$id")
#   TARGET_STATUS  - Status value that means "ready" (e.g., "active", "running")
#   STATUS_PY      - Python expression to extract status from JSON (receives 'd' as parsed dict)
#   IP_PY          - Python expression to extract IP from JSON (receives 'd' as parsed dict)
#   IP_VAR         - Environment variable name to export with the IP (e.g., "VULTR_SERVER_IP")
#   DESCRIPTION    - Human-readable label for logging (e.g., "Vultr instance")
#   MAX_ATTEMPTS   - Optional, defaults to 60
#
# Example:
#   generic_wait_for_instance vultr_api "/instances/$id" "active" \
#       "d['instance']['status']" "d['instance']['main_ip']" \
#       VULTR_SERVER_IP "Instance" 60
# Single polling attempt: fetch status, check readiness, log progress.
# Returns 0 if instance is ready (IP exported), 1 to keep polling, 2 on status mismatch.
# Arguments: API_FUNC ENDPOINT TARGET_STATUS STATUS_PY IP_PY IP_VAR DESCRIPTION ATTEMPT POLL_DELAY
_poll_instance_once() {
    local api_func="${1}" endpoint="${2}" target_status="${3}"
    local status_py="${4}" ip_py="${5}" ip_var="${6}"
    local description="${7}" attempt="${8}" poll_delay="${9}"

    local response
    response=$("${api_func}" GET "${endpoint}" 2>/dev/null) || true

    local status
    status=$(_extract_json_field "${response}" "${status_py}" "unknown")

    if [[ "${status}" != "${target_status}" ]]; then
        log_step "${description} status: ${status} ($((attempt * poll_delay))s elapsed)"
        return 2
    fi

    local ip
    ip=$(_extract_json_field "${response}" "${ip_py}")
    if [[ -n "${ip}" ]]; then
        # SECURITY: Validate ip_var to prevent command injection
        if [[ ! "${ip_var}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            log_error "SECURITY: Invalid env var name rejected: ${ip_var}"
            return 1
        fi
        export "${ip_var}=${ip}"
        log_info "${description} ready (IP: ${ip})"
        return 0
    fi

    log_step "${description} status: ${status} ($((attempt * poll_delay))s elapsed)"
    return 1
}

# Report timeout when instance polling exhausts all attempts.
_report_instance_timeout() {
    local description="${1}" target_status="${2}" total_time="${3}"
    log_error "${description} did not become ${target_status} within ${total_time}s"
    log_error ""
    log_error "The cloud provider API reported the instance is not yet ready."
    log_error ""
    log_error "This usually means:"
    log_error "  - Cloud provider is experiencing delays (high load, maintenance)"
    log_error "  - The region or instance type has limited capacity"
    log_error "  - The instance failed to provision but the API hasn't reported it yet"
    log_error ""
    log_error "Next steps:"
    log_error "  1. Check your cloud dashboard for instance status and error messages"
    if [[ -n "${SPAWN_DASHBOARD_URL:-}" ]]; then
        log_error "     ${SPAWN_DASHBOARD_URL}"
    fi
    log_error "  2. Wait 2-3 minutes and retry the spawn command"
    log_error "  3. Try a different region or instance size if this persists"
}

generic_wait_for_instance() {
    local api_func="${1}" endpoint="${2}" target_status="${3}"
    local status_py="${4}" ip_py="${5}" ip_var="${6}"
    local description="${7}" max_attempts="${8:-60}"
    local poll_delay="${INSTANCE_STATUS_POLL_DELAY:-5}"

    local attempt=1
    log_step "Waiting for ${description} to become ${target_status}..."

    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        _poll_instance_once "${api_func}" "${endpoint}" "${target_status}" \
            "${status_py}" "${ip_py}" "${ip_var}" \
            "${description}" "${attempt}" "${poll_delay}" && return 0
        sleep "${poll_delay}"
        attempt=$((attempt + 1))
    done

    _report_instance_timeout "${description}" "${target_status}" "$((max_attempts * poll_delay))"
    return 1
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

    # SECURITY: Validate env_var_name to prevent command injection
    if [[ ! "${env_var_name}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
        log_error "SECURITY: Invalid env var name rejected: ${env_var_name}"
        return 1
    fi

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
        log_error "The token may be expired, revoked, or incorrectly copied."
        log_error ""
        log_error "How to fix:"
        log_error "  1. Re-run the command to enter a new token"
        log_error "  2. Or set it directly: ${env_var_name}=your-token spawn ..."
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

    local escaped_token
    escaped_token=$(json_escape "${token}")
    printf '{\n  "api_key": %s,\n  "token": %s\n}\n' "${escaped_token}" "${escaped_token}" > "${config_file}"
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
    log_step "${provider_name} API Token Required"
    log_step "Get your token from: ${help_url}"
    echo ""

    local token
    token=$(validated_read "Enter your ${provider_name} API token: " validate_api_token) || return 1

    # SECURITY: Validate env_var_name to prevent command injection
    if [[ ! "${env_var_name}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
        log_error "SECURITY: Invalid env var name rejected: ${env_var_name}"
        return 1
    fi

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
# Multi-credential configuration helpers
# ============================================================

# Load multiple fields from a JSON config file in a single python3 call.
# Outputs each field value on a separate line. Returns 1 if file missing or parse fails.
# Usage: local creds; creds=$(_load_json_config_fields CONFIG_FILE field1 field2 ...)
# Then:  { read -r var1; read -r var2; ... } <<< "${creds}"
_load_json_config_fields() {
    local config_file="${1}"; shift
    [[ -f "${config_file}" ]] || return 1

    local py_fields=""
    for field in "$@"; do
        py_fields="${py_fields}print(d.get('${field}', ''));"
    done

    python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
${py_fields}
" "${config_file}" 2>/dev/null || return 1
}

# Save key-value pairs to a JSON config file using json_escape for safe encoding.
# Usage: _save_json_config CONFIG_FILE key1 val1 key2 val2 ...
_save_json_config() {
    local config_file="${1}"; shift

    mkdir -p "$(dirname "${config_file}")"

    # Build JSON object from key=value pairs
    local json="{"
    local first=true
    while [[ $# -ge 2 ]]; do
        local key="${1}"; shift
        local val="${1}"; shift
        if [[ "${first}" == "true" ]]; then
            first=false
        else
            json="${json},"
        fi
        json="${json}
  \"${key}\": $(json_escape "${val}")"
    done
    json="${json}
}
"

    printf '%s\n' "${json}" > "${config_file}"
    chmod 600 "${config_file}"
    log_info "Credentials saved to ${config_file}"
}

# Check if all env vars in a list are set (non-empty)
# Returns 0 if all set, 1 if any missing
_multi_creds_all_env_set() {
    local var
    for var in "$@"; do
        if [[ -z "${!var:-}" ]]; then
            return 1
        fi
    done
    return 0
}

# Load multi-credentials from a JSON config file into env vars.
# Returns 0 if all fields loaded, 1 if any missing.
# Usage: _multi_creds_load_config CONFIG_FILE env_vars[@] config_keys[@]
_multi_creds_load_config() {
    local config_file="${1}"
    shift
    local env_count="${1}"
    shift
    local env_vars=("${@:1:$env_count}")
    shift "${env_count}"
    local config_keys=("$@")

    local creds
    creds=$(_load_json_config_fields "${config_file}" "${config_keys[@]}") || return 1

    local i=0
    while IFS= read -r value; do
        if [[ -z "${value}" ]]; then
            return 1
        fi
        # SECURITY: Validate env var name before export
        if [[ ! "${env_vars[$i]}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            log_error "SECURITY: Invalid env var name rejected: ${env_vars[$i]}"
            return 1
        fi
        export "${env_vars[$i]}=${value}"
        i=$((i + 1))
    done <<< "${creds}"

    [[ "${i}" -eq "${#env_vars[@]}" ]] || return 1
    return 0
}

# Prompt user for each credential interactively.
# Returns 1 if any input is empty or read fails.
_multi_creds_prompt() {
    local provider_name="${1}"
    local help_url="${2}"
    shift 2
    local env_count="${1}"
    shift
    local env_vars=("${@:1:$env_count}")
    shift "${env_count}"
    local labels=("$@")

    echo ""
    log_step "${provider_name} API Credentials Required"
    log_step "Get your credentials from: ${help_url}"
    echo ""

    local idx
    for idx in $(seq 0 $((${#env_vars[@]} - 1))); do
        # SECURITY: Validate env var name before export
        if [[ ! "${env_vars[$idx]}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            log_error "SECURITY: Invalid env var name rejected: ${env_vars[$idx]}"
            return 1
        fi
        local val
        val=$(safe_read "Enter ${provider_name} ${labels[$idx]}: ") || return 1
        if [[ -z "${val}" ]]; then
            log_error "${labels[$idx]} is required"
            return 1
        fi
        export "${env_vars[$idx]}=${val}"
    done
    return 0
}

# Validate multi-credentials using a test function.
# Unsets all env vars on failure.
_multi_creds_validate() {
    local test_func="${1}"
    local provider_name="${2}"
    shift 2

    if [[ -z "${test_func}" ]]; then
        return 0
    fi

    log_step "Testing ${provider_name} credentials..."
    if ! "${test_func}"; then
        log_error "Invalid ${provider_name} credentials"
        log_error "The credentials may be expired, revoked, or incorrectly copied."
        log_error "Please re-run the command to enter new credentials."
        local v
        for v in "$@"; do
            unset "${v}"
        done
        return 1
    fi
    return 0
}

# Generic multi-credential ensure function
# Eliminates duplicated env-var/config/prompt/test/save logic across providers
# that need more than one credential (username+password, client_id+secret, etc.)
#
# Usage: ensure_multi_credentials PROVIDER_NAME CONFIG_FILE HELP_URL TEST_FUNC \
#          "ENV_VAR:config_key:Prompt Label" ...
#
# Each credential spec is a colon-delimited triple:
#   ENV_VAR    - Environment variable name (e.g., CONTABO_CLIENT_ID)
#   config_key - JSON key in the config file (e.g., client_id)
#   Prompt Label - Human-readable label for prompting (e.g., "Client ID")
ensure_multi_credentials() {
    local provider_name="${1}"
    local config_file="${2}"
    local help_url="${3}"
    local test_func="${4:-}"
    shift 4

    check_python_available || return 1

    # Parse credential specs into parallel arrays
    local env_vars=() config_keys=() labels=()
    local spec
    for spec in "$@"; do
        env_vars+=("${spec%%:*}")
        local rest="${spec#*:}"
        config_keys+=("${rest%%:*}")
        labels+=("${rest#*:}")
    done

    local n="${#env_vars[@]}"

    # 1. All env vars already set?
    if _multi_creds_all_env_set "${env_vars[@]}"; then
        log_info "Using ${provider_name} credentials from environment"
        return 0
    fi

    # 2. Try loading from config file
    if _multi_creds_load_config "${config_file}" "${n}" "${env_vars[@]}" "${config_keys[@]}"; then
        log_info "Using ${provider_name} credentials from ${config_file}"
        return 0
    fi

    # 3. Prompt for each credential
    _multi_creds_prompt "${provider_name}" "${help_url}" "${n}" "${env_vars[@]}" "${labels[@]}" || return 1

    # 4. Validate credentials
    _multi_creds_validate "${test_func}" "${provider_name}" "${env_vars[@]}" || return 1

    # 5. Save to config file
    local save_args=()
    local idx
    for idx in $(seq 0 $((n - 1))); do
        save_args+=("${config_keys[$idx]}" "${!env_vars[$idx]}")
    done
    _save_json_config "${config_file}" "${save_args[@]}"
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

    # Use mktemp-derived randomness for the remote temp path to avoid predictable names
    local rand_suffix
    rand_suffix=$(basename "${temp_file}")
    local temp_remote="/tmp/spawn_config_${rand_suffix}"
    ${upload_callback} "${temp_file}" "${temp_remote}"
    # NOTE: remote_path must NOT be single-quoted — tilde (~) only expands when unquoted
    ${run_callback} "mkdir -p \$(dirname ${remote_path}) && chmod 600 '${temp_remote}' && mv '${temp_remote}' ${remote_path}"
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

    log_step "Configuring Claude Code..."

    # Create ~/.claude directory
    ${run_callback} "mkdir -p ~/.claude"

    # Create settings.json
    local escaped_key
    escaped_key=$(json_escape "${openrouter_key}")
    local settings_json
    settings_json=$(cat << EOF
{
  "theme": "dark",
  "editor": "vim",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": ${escaped_key}
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  }
}
EOF
)
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
# Generate openclaw.json configuration with escaped credentials
_generate_openclaw_json() {
    local openrouter_key="${1}"
    local model_id="${2}"
    local gateway_token="${3}"

    local escaped_key escaped_token
    escaped_key=$(json_escape "${openrouter_key}")
    escaped_token=$(json_escape "${gateway_token}")

    cat << EOF
{
  "env": {
    "OPENROUTER_API_KEY": ${escaped_key}
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "token": ${escaped_token}
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
}

setup_openclaw_config() {
    local openrouter_key="${1}"
    local model_id="${2}"
    local upload_callback="${3}"
    local run_callback="${4}"

    log_step "Configuring openclaw..."

    # Create ~/.openclaw directory
    ${run_callback} "rm -rf ~/.openclaw && mkdir -p ~/.openclaw"

    # Generate a random gateway token
    local gateway_token
    gateway_token=$(openssl rand -hex 16)

    # Create and upload openclaw.json config
    local openclaw_json
    openclaw_json=$(_generate_openclaw_json "${openrouter_key}" "${model_id}" "${gateway_token}")
    upload_config_file "${upload_callback}" "${run_callback}" "${openclaw_json}" "~/.openclaw/openclaw.json"
}

# ============================================================
# Continue configuration setup
# ============================================================

# Setup Continue configuration files (config.json)
# This consolidates the config setup pattern used by all continue.sh scripts
# Usage: setup_continue_config OPENROUTER_KEY UPLOAD_CALLBACK RUN_CALLBACK
#
# Arguments:
#   OPENROUTER_KEY    - OpenRouter API key to inject into config
#   UPLOAD_CALLBACK   - Function to upload files: func(local_path, remote_path)
#   RUN_CALLBACK      - Function to run commands: func(command)
#
# Example (SSH-based clouds):
#   setup_continue_config "$OPENROUTER_API_KEY" \
#     "upload_file $SERVER_IP" \
#     "run_server $SERVER_IP"
#
# Example (container clouds):
#   setup_continue_config "$OPENROUTER_API_KEY" \
#     "upload_file" \
#     "run_server"
setup_continue_config() {
    local openrouter_key="${1}"
    local upload_callback="${2}"
    local run_callback="${3}"

    log_step "Configuring Continue..."

    # Create ~/.continue directory
    ${run_callback} "mkdir -p ~/.continue"

    # Create config.json with json_escape to prevent injection
    local escaped_key
    escaped_key=$(json_escape "${openrouter_key}")
    local continue_json
    continue_json=$(cat << EOF
{
  "models": [
    {
      "title": "OpenRouter",
      "provider": "openrouter",
      "model": "openrouter/auto",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKey": ${escaped_key}
    }
  ]
}
EOF
)
    upload_config_file "${upload_callback}" "${run_callback}" "${continue_json}" "~/.continue/config.json"
}

# ============================================================
# Interactive selection helpers
# ============================================================

# Generic interactive picker for numbered menu selection
# Eliminates duplicate _pick_location/_pick_server_type patterns across providers
#
# Usage: interactive_pick ENV_VAR_NAME DEFAULT_VALUE PROMPT_TEXT LIST_CALLBACK [FORMAT_CALLBACK]
#
# Arguments:
#   ENV_VAR_NAME     - Environment variable to check first (e.g., "HETZNER_LOCATION")
#   DEFAULT_VALUE    - Default value if env var unset and list is empty or choice invalid
#   PROMPT_TEXT      - Label shown above the menu (e.g., "locations", "server types")
#   LIST_CALLBACK    - Function that outputs pipe-delimited lines (first field = ID)
#   DEFAULT_ID       - Optional: ID to pre-select as default (e.g., "cpx11")
#
# LIST_CALLBACK must output pipe-delimited lines where the first field is the selectable ID.
# Example output: "fsn1|Falkenstein|DE" or "cpx11|2 vCPU|4 GB RAM|40 GB disk"
#
# Display a numbered list and read user selection
# Pipe-delimited items: "id|label". Returns selected id via stdout.
# Usage: _display_and_select PROMPT_TEXT DEFAULT_VALUE DEFAULT_ID <<< "$items"
_display_and_select() {
    local prompt_text="${1}"
    local default_value="${2}"
    local default_id="${3:-}"

    log_step "Available ${prompt_text}:"
    local i=1
    local ids=()
    local default_idx=1
    while IFS= read -r line; do
        local id="${line%%|*}"
        printf "  %2d) %s\n" "${i}" "$(echo "${line}" | tr '|' '\t')" >&2
        ids+=("${id}")
        if [[ -n "${default_id}" && "${id}" == "${default_id}" ]]; then
            default_idx=${i}
        fi
        i=$((i + 1))
    done

    local choice
    printf "\n" >&2
    choice=$(safe_read "Select ${prompt_text%s} [${default_idx}]: ") || choice=""
    choice="${choice:-${default_idx}}"

    if [[ "${choice}" -ge 1 && "${choice}" -le "${#ids[@]}" ]] 2>/dev/null; then
        echo "${ids[$((choice - 1))]}"
    else
        log_warn "Invalid selection '${choice}' (enter a number between 1 and ${#ids[@]}). Using default: ${default_value}"
        echo "${default_value}"
    fi
}

# Returns: selected ID via stdout
interactive_pick() {
    local env_var_name="${1}"
    local default_value="${2}"
    local prompt_text="${3}"
    local list_callback="${4}"
    local default_id="${5:-}"

    # Check environment variable first
    local env_value="${!env_var_name:-}"
    if [[ -n "${env_value}" ]]; then
        echo "${env_value}"
        return
    fi

    log_step "Fetching available ${prompt_text}..."
    local items
    items=$("${list_callback}")

    if [[ -z "${items}" ]]; then
        log_warn "Could not fetch ${prompt_text}, using default: ${default_value}"
        echo "${default_value}"
        return
    fi

    _display_and_select "${prompt_text}" "${default_value}" "${default_id}" <<< "${items}"
}

# ============================================================
# SSH key registration helpers
# ============================================================

# Generic SSH key check: queries the provider's API and greps for the fingerprint.
# Most providers follow this exact pattern. Use this to avoid duplicating 5-line
# check functions across every cloud lib.
# Usage: check_ssh_key_by_fingerprint API_FUNC ENDPOINT FINGERPRINT
# Example: check_ssh_key_by_fingerprint hetzner_api "/ssh_keys" "$fingerprint"
check_ssh_key_by_fingerprint() {
    local api_func="${1}"
    local endpoint="${2}"
    local fingerprint="${3}"

    local existing_keys
    existing_keys=$("${api_func}" GET "${endpoint}")
    echo "${existing_keys}" | grep -q "${fingerprint}"
}

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
    log_step "Registering SSH key with ${provider_name}..."
    local key_name
    key_name="spawn-$(hostname)-$(date +%s)"

    if "${register_callback}" "${key_name}" "${pub_path}"; then
        log_info "SSH key registered with ${provider_name}"
        return 0
    else
        log_error "Failed to register SSH key with ${provider_name}"
        log_error "The API may have rejected the key format or the token lacks write permissions."
        log_error "Verify your API token has SSH key management permissions, then try again."
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
