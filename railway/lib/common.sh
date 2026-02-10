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

    # Railway recommends installing via npm/bun
    local node_runtime
    node_runtime=$(find_node_runtime)

    if [[ -z "$node_runtime" ]]; then
        log_error "Railway CLI requires Node.js or Bun"
        log_error "Install one of:"
        log_error "  - Bun: curl -fsSL https://bun.sh/install | bash"
        log_error "  - Node.js: https://nodejs.org/"
        return 1
    fi

    # Install using the detected runtime
    if [[ "$node_runtime" == "bun" ]]; then
        if ! bun install -g @railway/cli; then
            log_error "Failed to install Railway CLI via Bun"
            return 1
        fi
    else
        if ! npm install -g @railway/cli; then
            log_error "Failed to install Railway CLI via npm"
            return 1
        fi
    fi

    # Verify installation
    if ! command -v railway &>/dev/null; then
        log_error "Railway CLI not found in PATH after installation"
        log_error "Try adding ~/.bun/bin or npm global bin to PATH"
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

# Generate a unique server name for Railway (must be lowercase alphanumeric + hyphens)
get_server_name() {
    local prefix="${1:-spawn}"
    local timestamp=$(date +%s)
    local random_suffix=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "${prefix}-${timestamp}-${random_suffix}" | tr '[:upper:]' '[:lower:]'
}

# Create a Railway project
# Usage: _railway_create_project PROJECT_NAME
# Sets: RAILWAY_PROJECT_ID
_railway_create_project() {
    local project_name="$1"
    log_warn "Creating Railway project: $project_name"

    # Use railway init to create a new project non-interactively
    local init_output
    init_output=$(railway init --name "$project_name" 2>&1)

    if echo "$init_output" | grep -q "error"; then
        log_error "Failed to create Railway project"
        log_error "$init_output"
        return 1
    fi

    # Get project ID from status
    RAILWAY_PROJECT_ID=$(railway status --json 2>/dev/null | python3 -c "import json, sys; data = json.load(sys.stdin); print(data.get('project', {}).get('id', ''))" 2>/dev/null)

    if [[ -z "$RAILWAY_PROJECT_ID" ]]; then
        log_error "Failed to get Railway project ID"
        return 1
    fi

    log_info "Railway project created: $project_name (ID: $RAILWAY_PROJECT_ID)"
}

# Add a service to the Railway project with Docker image
# Usage: _railway_add_service SERVICE_NAME
# Sets: RAILWAY_SERVICE_ID
_railway_add_service() {
    local service_name="$1"
    log_warn "Adding Railway service: $service_name"

    # Create a temporary directory for service configuration
    local temp_dir
    temp_dir=$(mktemp -d)
    cd "$temp_dir"

    # Create a Dockerfile that keeps the container running
    cat > Dockerfile << 'EOF'
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y curl wget git python3 python3-pip build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
CMD ["tail", "-f", "/dev/null"]
EOF

    # Deploy the service
    local deploy_output
    deploy_output=$(railway up --detach 2>&1)

    # Clean up temp directory
    cd - > /dev/null
    rm -rf "$temp_dir"

    if echo "$deploy_output" | grep -q "error"; then
        log_error "Failed to deploy Railway service"
        log_error "$deploy_output"
        return 1
    fi

    # Get service ID from status
    RAILWAY_SERVICE_ID=$(railway status --json 2>/dev/null | python3 -c "import json, sys; data = json.load(sys.stdin); services = data.get('services', []); print(services[0].get('id', '') if services else '')" 2>/dev/null)

    if [[ -z "$RAILWAY_SERVICE_ID" ]]; then
        log_error "Failed to get Railway service ID"
        return 1
    fi

    log_info "Railway service added: $service_name (ID: $RAILWAY_SERVICE_ID)"
}

# Wait for Railway deployment to complete
# Usage: _railway_wait_for_deployment [MAX_ATTEMPTS]
_railway_wait_for_deployment() {
    local max_attempts=${1:-60}
    local attempt=0

    log_warn "Waiting for deployment to complete..."
    while [[ $attempt -lt $max_attempts ]]; do
        local status
        status=$(railway status --json 2>/dev/null | python3 -c "import json, sys; data = json.load(sys.stdin); deployments = data.get('deployments', []); print(deployments[0].get('status', '') if deployments else '')" 2>/dev/null)

        if [[ "$status" == "SUCCESS" || "$status" == "ACTIVE" ]]; then
            log_info "Deployment is ready"
            return 0
        fi

        if [[ "$status" == "FAILED" || "$status" == "CRASHED" ]]; then
            log_error "Deployment failed"
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 5
    done

    log_error "Timeout waiting for deployment to be ready"
    return 1
}

# Create a Railway project and service
# Sets: RAILWAY_PROJECT_NAME, RAILWAY_SERVICE_NAME, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID
create_server() {
    local name="${1:-$(get_server_name)}"

    RAILWAY_PROJECT_NAME="${name}"
    RAILWAY_SERVICE_NAME="${name}-svc"

    _railway_create_project "$RAILWAY_PROJECT_NAME" || return 1
    _railway_add_service "$RAILWAY_SERVICE_NAME" || return 1
    _railway_wait_for_deployment || return 1
}

# Run a command on the Railway service
run_server() {
    local cmd="$1"

    if [[ -z "$RAILWAY_SERVICE_ID" ]]; then
        log_error "No service ID set. Call create_server first."
        return 1
    fi

    railway run bash -c "$cmd"
}

# Upload a file to the Railway service via base64 encoding
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

# Wait for basic system readiness (Railway doesn't use cloud-init)
wait_for_cloud_init() {
    log_info "Railway service ready (Docker image pre-configured)"
    # The Docker image already has the tools installed, no need to wait
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

    if [[ -z "$RAILWAY_SERVICE_ID" ]]; then
        log_error "No service ID set. Call create_server first."
        return 1
    fi

    log_info "Starting interactive session..."
    railway run bash -c "$launch_cmd"
}

# Cleanup: delete the service and project
cleanup_server() {
    if [[ -n "${RAILWAY_SERVICE_ID:-}" ]]; then
        log_warn "Deleting Railway service: $RAILWAY_SERVICE_NAME"
        railway service delete --yes >/dev/null 2>&1 || true
    fi

    if [[ -n "${RAILWAY_PROJECT_ID:-}" ]]; then
        log_warn "Deleting Railway project: $RAILWAY_PROJECT_NAME"
        railway project delete --yes >/dev/null 2>&1 || true
    fi
}
