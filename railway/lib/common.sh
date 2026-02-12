#!/bin/bash
# Common bash functions for Railway spawn scripts
# Uses Railway CLI for provisioning and exec access

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
# Railway specific functions
# ============================================================

# Ensure Railway CLI is installed
ensure_railway_cli() {
    if command -v railway &>/dev/null; then
        log_info "Railway CLI available"
        return 0
    fi

    log_step "Installing Railway CLI..."

    # Railway CLI is installed via npm
    if ! command -v npm &>/dev/null; then
        log_error "npm is required to install Railway CLI"
        log_error "Install Node.js/npm from https://nodejs.org/ or use your package manager"
        return 1
    fi

    if ! npm install -g @railway/cli; then
        log_error "Failed to install Railway CLI"
        log_error "Install manually: npm install -g @railway/cli"
        log_error "See: https://docs.railway.app/develop/cli"
        return 1
    fi

    if ! command -v railway &>/dev/null; then
        log_error "Railway CLI not found in PATH after installation"
        return 1
    fi

    log_info "Railway CLI installed"
}

# Ensure RAILWAY_TOKEN is available (env var -> config file -> prompt+save)
ensure_railway_token() {
    ensure_api_token_with_provider \
        "Railway" \
        "RAILWAY_TOKEN" \
        "$HOME/.config/spawn/railway.json" \
        "https://railway.app/account/tokens"
}

# Generate a unique project and service name for Railway
get_server_name() {
    local prefix="${1:-spawn}"
    local timestamp=$(date +%s)
    local random_suffix=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "${prefix}-${timestamp}-${random_suffix}" | tr '[:upper:]' '[:lower:]'
}

# Create and link a Railway project
# Sets: RAILWAY_SERVICE_NAME
# Usage: _railway_create_project NAME
_railway_create_project() {
    local name="$1"

    log_step "Creating Railway project: $name"

    local project_output
    project_output=$(railway init -n "$name" 2>&1)

    if echo "$project_output" | grep -qi "error"; then
        log_error "Failed to create Railway project"
        log_error "$project_output"
        return 1
    fi

    railway link "$name" >/dev/null 2>&1 || {
        log_error "Failed to link to Railway project"
        return 1
    }

    log_info "Railway project created: $name"
}

# Deploy an Ubuntu container to the linked Railway project
# Usage: _railway_deploy_container
_railway_deploy_container() {
    log_step "Deploying service..."

    local temp_dir=$(mktemp -d)
    cat > "$temp_dir/Dockerfile" <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y \
    curl wget git python3 python3-pip build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
CMD ["tail", "-f", "/dev/null"]
EOF

    (cd "$temp_dir" && railway up --detach) || {
        log_error "Failed to deploy Railway service"
        rm -rf "$temp_dir"
        return 1
    }

    rm -rf "$temp_dir"
}

# Wait for the Railway deployment to become ready
# Usage: _railway_wait_for_deployment [MAX_ATTEMPTS]
_railway_wait_for_deployment() {
    local max_attempts="${1:-60}"
    local attempt=0

    log_step "Waiting for service to deploy..."

    while [[ $attempt -lt $max_attempts ]]; do
        local status
        status=$(railway status 2>/dev/null | grep -i "status" | head -1 || echo "")

        if echo "$status" | grep -qi "success\|active\|running\|healthy"; then
            log_info "Service is ready"
            return 0
        fi

        if echo "$status" | grep -qi "failed\|error"; then
            log_error "Service deployment failed"
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 5
    done

    log_error "Timeout waiting for service to be ready"
    return 1
}

# Create a Railway project and service via CLI
# Sets: RAILWAY_SERVICE_NAME
create_server() {
    local name="${1:-$(get_server_name)}"

    RAILWAY_SERVICE_NAME="${name}"

    _railway_create_project "$name" || return 1
    _railway_deploy_container || return 1
    _railway_wait_for_deployment || return 1

    log_info "Railway service deployed successfully"
}

# Run a command on the Railway service
# SECURITY: Uses printf %q to properly escape commands to prevent injection
run_server() {
    local cmd="$1"

    # Railway CLI doesn't have a direct exec - we use shell command via railway run
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    railway run bash -c "$escaped_cmd"
}

# Upload a file to the Railway service
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    if [[ ! -f "$local_path" ]]; then
        log_error "Local file not found: $local_path"
        return 1
    fi

    # SECURITY: base64 -w0 produces single-line output (no newline injection)
    # macOS base64 doesn't support -w0 but produces single-line by default
    local content
    content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")

    # SECURITY: Properly escape remote_path to prevent injection via single-quote breakout
    local escaped_path
    escaped_path=$(printf '%q' "$remote_path")

    # base64 output is alphanumeric+/+= so safe without escaping
    run_server "printf '%s' '${content}' | base64 -d > ${escaped_path}"
}

# Wait for system readiness (Railway containers start with Ubuntu base)
wait_for_cloud_init() {
    log_step "Verifying system packages..."

    # Update package lists if needed
    run_server "apt-get update -qq >/dev/null 2>&1 || true" || {
        log_step "Package update skipped (may already be ready)"
    }

    log_info "System ready"
}

# Inject environment variables into shell config
# Writes to a temp file and uploads to avoid shell interpolation of values
inject_env_vars() {
    log_step "Injecting environment variables..."

    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Upload and append to .bashrc (Railway containers use bash)
    upload_file "${env_temp}" "/tmp/env_config"
    run_server "cat /tmp/env_config >> /root/.bashrc && rm /tmp/env_config"

    log_info "Environment variables configured"
}

# Start an interactive session via Railway SSH
interactive_session() {
    local launch_cmd="${1:-bash}"

    log_info "Starting interactive session..."

    # Railway CLI has a shell command for interactive sessions
    railway shell
}

# Cleanup: delete the project
cleanup_server() {
    if [[ -n "${RAILWAY_SERVICE_NAME:-}" ]]; then
        log_step "Deleting Railway project: $RAILWAY_SERVICE_NAME"
        railway delete --yes >/dev/null 2>&1 || true
    fi
}
