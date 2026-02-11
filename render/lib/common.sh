#!/bin/bash
# Common bash functions for Render spawn scripts
# Uses Render CLI for provisioning and SSH access

# Bash safety flags
set -eo pipefail

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# Render specific functions
# ============================================================

# Ensure Render CLI is installed
ensure_render_cli() {
    if command -v render &>/dev/null; then
        log_info "Render CLI available"
        return 0
    fi

    log_warn "Installing Render CLI..."

    # Render CLI installation via npm
    local node_runtime
    node_runtime=$(find_node_runtime)

    if [[ -z "$node_runtime" ]]; then
        log_error "Render CLI requires Node.js or Bun"
        log_error "Install one of:"
        log_error "  - Bun: curl -fsSL https://bun.sh/install | bash"
        log_error "  - Node.js: https://nodejs.org/"
        return 1
    fi

    # Install using the detected runtime
    if [[ "$node_runtime" == "bun" ]]; then
        if ! bun install -g @render-oss/cli; then
            log_error "Failed to install Render CLI via Bun"
            return 1
        fi
    else
        if ! npm install -g @render-oss/cli; then
            log_error "Failed to install Render CLI via npm"
            return 1
        fi
    fi

    # Verify installation
    if ! command -v render &>/dev/null; then
        log_error "Render CLI not found in PATH after installation"
        log_error "Try adding ~/.bun/bin or npm global bin to PATH"
        return 1
    fi

    log_info "Render CLI installed"
}

# Ensure RENDER_API_KEY is available (env var -> config file -> prompt+save)
ensure_render_api_key() {
    ensure_api_token_with_provider \
        "Render" \
        "RENDER_API_KEY" \
        "$HOME/.config/spawn/render.json" \
        "https://dashboard.render.com/u/settings/api-keys" \
        ""
}

# Generate a unique server name for Render (must be lowercase alphanumeric + hyphens)
get_server_name() {
    local prefix="${1:-spawn}"
    local timestamp=$(date +%s)
    local random_suffix=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "${prefix}-${timestamp}-${random_suffix}" | tr '[:upper:]' '[:lower:]'
}

# Create a Render web service using the API
# Usage: _render_create_service SERVICE_NAME
# Sets: RENDER_SERVICE_ID
_render_create_service() {
    local service_name="$1"
    log_warn "Creating Render web service: $service_name"

    # Build JSON body safely via Python to prevent injection
    local body
    body=$(printf '%s' "$service_name" | python3 -c "
import json, sys
name = sys.stdin.read()
body = {
    'type': 'web_service',
    'name': name,
    'runtime': 'docker',
    'dockerfilePath': './Dockerfile',
    'repo': 'https://github.com/render-examples/docker-hello-world',
    'autoDeploy': 'yes',
    'serviceDetails': {
        'plan': 'starter',
        'region': 'oregon',
        'healthCheckPath': '/',
        'env': 'docker',
        'disk': None
    }
}
print(json.dumps(body))
")

    # Create service via API
    local create_response
    create_response=$(curl -s -X POST "https://api.render.com/v1/services" \
        -H "Authorization: Bearer ${RENDER_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$body" 2>&1)

    if echo "$create_response" | grep -q "error"; then
        log_error "Failed to create Render service"
        log_error "$create_response"
        return 1
    fi

    # Extract service ID from response
    RENDER_SERVICE_ID=$(echo "$create_response" | python3 -c "import json, sys; data = json.load(sys.stdin); print(data.get('service', {}).get('id', ''))" 2>/dev/null)

    if [[ -z "$RENDER_SERVICE_ID" ]]; then
        log_error "Failed to get Render service ID from response"
        return 1
    fi

    log_info "Render service created: $service_name (ID: $RENDER_SERVICE_ID)"
}

# Wait for Render service to become live
# Usage: _render_wait_for_service SERVICE_ID [MAX_ATTEMPTS]
_render_wait_for_service() {
    local service_id="$1"
    local max_attempts=${2:-60}
    local attempt=0

    log_warn "Waiting for service to be live..."
    while [[ $attempt -lt $max_attempts ]]; do
        local status
        status=$(curl -s "https://api.render.com/v1/services/${service_id}" \
            -H "Authorization: Bearer ${RENDER_API_KEY}" | \
            python3 -c "import json, sys; data = json.load(sys.stdin); print(data.get('service', {}).get('serviceDetails', {}).get('deployStatus', ''))" 2>/dev/null)

        if [[ "$status" == "live" ]]; then
            log_info "Service is live"
            return 0
        fi

        if [[ "$status" == "failed" ]]; then
            log_error "Service deployment failed"
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 5
    done

    log_error "Timeout waiting for service to be live"
    return 1
}

# Create a Render service
# Sets: RENDER_SERVICE_NAME, RENDER_SERVICE_ID
create_server() {
    local name="${1:-$(get_server_name)}"

    RENDER_SERVICE_NAME="${name}"

    _render_create_service "$RENDER_SERVICE_NAME" || return 1
    _render_wait_for_service "$RENDER_SERVICE_ID" || return 1
}

# Run a command on the Render service via SSH
run_server() {
    local cmd="$1"

    if [[ -z "$RENDER_SERVICE_ID" ]]; then
        log_error "No service ID set. Call create_server first."
        return 1
    fi

    render ssh --service "$RENDER_SERVICE_ID" -- bash -c "$cmd"
}

# Upload a file to the Render service via base64 encoding over SSH
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    if [[ ! -f "$local_path" ]]; then
        log_error "Local file not found: $local_path"
        return 1
    fi

    # Validate remote_path to prevent command injection
    if [[ "$remote_path" == *"'"* || "$remote_path" == *'$'* || "$remote_path" == *'`'* || "$remote_path" == *$'\n'* ]]; then
        log_error "Invalid remote path (contains unsafe characters): $remote_path"
        return 1
    fi

    # Read file content and encode (base64 output is safe for shell embedding)
    local content
    content=$(base64 < "$local_path")

    # Write file on remote service
    run_server "printf '%s' '$content' | base64 -d > '$remote_path'"
}

# Wait for basic system readiness (Render services are pre-configured)
wait_for_cloud_init() {
    log_info "Render service ready (Docker image pre-configured)"
    # Render services are Docker-based and already configured
}

# Inject environment variables into shell config
# Writes to a temp file and uploads to avoid shell interpolation of values
inject_env_vars() {
    log_warn "Injecting environment variables..."

    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Upload and append to .bashrc
    upload_file "${env_temp}" "/tmp/env_config"
    run_server "cat /tmp/env_config >> /root/.bashrc && rm /tmp/env_config"

    log_info "Environment variables configured"
}

# Start an interactive session
interactive_session() {
    local launch_cmd="${1:-bash}"

    if [[ -z "$RENDER_SERVICE_ID" ]]; then
        log_error "No service ID set. Call create_server first."
        return 1
    fi

    log_info "Starting interactive session..."
    render ssh --service "$RENDER_SERVICE_ID" -- bash -c "$launch_cmd"
}

# Cleanup: delete the service
cleanup_server() {
    if [[ -n "${RENDER_SERVICE_ID:-}" ]]; then
        log_warn "Deleting Render service: $RENDER_SERVICE_NAME"
        curl -s -X DELETE "https://api.render.com/v1/services/${RENDER_SERVICE_ID}" \
            -H "Authorization: Bearer ${RENDER_API_KEY}" >/dev/null 2>&1 || true
    fi
}
