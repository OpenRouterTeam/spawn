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

    log_warn "Installing Railway CLI..."

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

# Save Railway token to config file
_save_railway_token() {
    local token="$1"
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/railway.json"
    mkdir -p "$config_dir"
    printf '{\n  "token": "%s"\n}\n' "$(json_escape "$token")" > "$config_file"
    chmod 600 "$config_file"
}

# Ensure RAILWAY_TOKEN is available (env var -> config file -> prompt+save)
ensure_railway_token() {
    check_python_available || return 1

    # 1. Check environment variable
    if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
        log_info "Using Railway API token from environment"
        return 0
    fi

    local config_file="$HOME/.config/spawn/railway.json"

    # 2. Check config file
    if [[ -f "$config_file" ]]; then
        local saved_token
        saved_token=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('token',''))" "$config_file" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export RAILWAY_TOKEN="$saved_token"
            log_info "Using Railway API token from $config_file"
            return 0
        fi
    fi

    # 3. Prompt user for token
    log_warn "Railway API token required"
    echo ""
    echo "Get your API token at: https://railway.app/account/tokens"
    echo ""

    local token
    token=$(safe_read "Enter Railway API token: ")
    if [[ -z "$token" ]]; then
        log_error "No token provided"
        return 1
    fi

    export RAILWAY_TOKEN="$token"
    _save_railway_token "$token"
    log_info "Railway API token saved"
}

# Generate a unique project and service name for Railway
get_server_name() {
    local prefix="${1:-spawn}"
    local timestamp=$(date +%s)
    local random_suffix=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "${prefix}-${timestamp}-${random_suffix}" | tr '[:upper:]' '[:lower:]'
}

# Create a Railway project and service via CLI
# Sets: RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_SERVICE_NAME
create_server() {
    local name="${1:-$(get_server_name)}"

    RAILWAY_SERVICE_NAME="${name}"

    log_warn "Creating Railway project: $RAILWAY_SERVICE_NAME"

    # Create new project with CLI
    local project_output
    project_output=$(railway init -n "$RAILWAY_SERVICE_NAME" 2>&1)

    if echo "$project_output" | grep -qi "error"; then
        log_error "Failed to create Railway project"
        log_error "$project_output"
        return 1
    fi

    # Link to the project we just created
    railway link "$RAILWAY_SERVICE_NAME" >/dev/null 2>&1 || {
        log_error "Failed to link to Railway project"
        return 1
    }

    log_info "Railway project created: $RAILWAY_SERVICE_NAME"

    # Deploy an Ubuntu container that stays alive
    log_warn "Deploying service..."

    # Create a minimal Dockerfile in a temp directory
    local temp_dir=$(mktemp -d)
    cat > "$temp_dir/Dockerfile" <<'EOF'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y \
    curl wget git python3 python3-pip build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
CMD ["tail", "-f", "/dev/null"]
EOF

    # Deploy from the temp directory
    (cd "$temp_dir" && railway up --detach) || {
        log_error "Failed to deploy Railway service"
        rm -rf "$temp_dir"
        return 1
    }

    rm -rf "$temp_dir"

    # Wait for deployment to be ready
    log_warn "Waiting for service to deploy..."
    local max_attempts=60
    local attempt=0

    while [[ $attempt -lt $max_attempts ]]; do
        local status
        status=$(railway status 2>/dev/null | grep -i "status" | head -1 || echo "")

        if echo "$status" | grep -qi "success\|active\|running\|healthy"; then
            log_info "Service is ready"
            break
        fi

        if echo "$status" | grep -qi "failed\|error"; then
            log_error "Service deployment failed"
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 5
    done

    if [[ $attempt -ge $max_attempts ]]; then
        log_error "Timeout waiting for service to be ready"
        return 1
    fi

    log_info "Railway service deployed successfully"
}

# Run a command on the Railway service
run_server() {
    local cmd="$1"

    # Railway CLI doesn't have a direct exec - we use shell command via railway run
    railway run bash -c "$cmd"
}

# Upload a file to the Railway service
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

    # Write file on remote service via railway run
    railway run bash -c "printf '%s' '$content' | base64 -d > '$remote_path'"
}

# Wait for system readiness (Railway containers start with Ubuntu base)
wait_for_cloud_init() {
    log_warn "Verifying system packages..."

    # Update package lists if needed
    run_server "apt-get update -qq >/dev/null 2>&1 || true" || {
        log_warn "Package update skipped (may already be ready)"
    }

    log_info "System ready"
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
        log_warn "Deleting Railway project: $RAILWAY_SERVICE_NAME"
        railway delete --yes >/dev/null 2>&1 || true
    fi
}
