#!/bin/bash
# Common bash functions for Koyeb spawn scripts
# Uses Koyeb CLI for provisioning and exec access

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
# Koyeb specific functions
# ============================================================

# Ensure Koyeb CLI is installed
ensure_koyeb_cli() {
    if command -v koyeb &>/dev/null; then
        log_info "Koyeb CLI available"
        return 0
    fi

    log_warn "Installing Koyeb CLI..."

    # Detect OS and architecture
    local os=""
    local arch=""

    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        *)
            log_error "Unsupported operating system: $(uname -s)"
            return 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="amd64" ;;
        arm64|aarch64) arch="arm64" ;;
        *)
            log_error "Unsupported architecture: $(uname -m)"
            return 1
            ;;
    esac

    local install_dir="$HOME/.koyeb/bin"
    mkdir -p "$install_dir"

    local download_url="https://github.com/koyeb/koyeb-cli/releases/latest/download/koyeb-${os}-${arch}"

    if ! curl -fsSL "$download_url" -o "$install_dir/koyeb"; then
        log_error "Failed to download Koyeb CLI"
        log_error "Install manually: https://www.koyeb.com/docs/build-and-deploy/cli/installation"
        return 1
    fi

    chmod +x "$install_dir/koyeb"
    export PATH="$install_dir:$PATH"

    if ! command -v koyeb &>/dev/null; then
        log_error "Koyeb CLI not found in PATH after installation"
        return 1
    fi

    log_info "Koyeb CLI installed"
}

# Save Koyeb token to config file
_save_koyeb_token() {
    local token="$1"
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/koyeb.json"
    mkdir -p "$config_dir"
    printf '{\n  "token": "%s"\n}\n' "$(json_escape "$token")" > "$config_file"
    chmod 600 "$config_file"
}

# Ensure KOYEB_TOKEN is available (env var -> config file -> prompt+save)
ensure_koyeb_token() {
    check_python_available || return 1

    # 1. Check environment variable
    if [[ -n "${KOYEB_TOKEN:-}" ]]; then
        log_info "Using Koyeb API token from environment"
        return 0
    fi

    local config_file="$HOME/.config/spawn/koyeb.json"

    # 2. Check config file
    if [[ -f "$config_file" ]]; then
        local saved_token
        saved_token=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('token',''))" "$config_file" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export KOYEB_TOKEN="$saved_token"
            log_info "Using Koyeb API token from $config_file"
            return 0
        fi
    fi

    # 3. Prompt user for token
    log_warn "Koyeb API token required"
    echo ""
    echo "Get your API token at: https://app.koyeb.com/account/api"
    echo ""

    local token
    token=$(safe_read "Enter Koyeb API token: ")
    if [[ -z "$token" ]]; then
        log_error "No token provided"
        return 1
    fi

    export KOYEB_TOKEN="$token"
    _save_koyeb_token "$token"
    log_info "Koyeb API token saved"
}

# Generate a unique server name for Koyeb (must be lowercase alphanumeric + hyphens)
get_server_name() {
    local prefix="${1:-spawn}"
    local timestamp=$(date +%s)
    local random_suffix=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "${prefix}-${timestamp}-${random_suffix}" | tr '[:upper:]' '[:lower:]'
}

# Create the Koyeb app resource
# Usage: _koyeb_create_app APP_NAME
_koyeb_create_app() {
    local app_name="$1"
    log_warn "Creating Koyeb app: $app_name"
    if ! koyeb app create "$app_name" >/dev/null 2>&1; then
        log_error "Failed to create Koyeb app"
        return 1
    fi
}

# Create a Koyeb service and extract its ID
# Sets: KOYEB_SERVICE_ID
# Usage: _koyeb_create_service APP_NAME SERVICE_NAME
_koyeb_create_service() {
    local app_name="$1"
    local service_name="$2"

    log_warn "Creating Koyeb service: $service_name"

    local create_output
    create_output=$(koyeb service create "$service_name" \
        --app "$app_name" \
        --docker ubuntu:24.04 \
        --regions was \
        --instance-type nano \
        --command '["tail"]' \
        --args '["-f", "/dev/null"]' \
        2>&1)

    if echo "$create_output" | grep -q "Error"; then
        log_error "Failed to create Koyeb service"
        log_error "$create_output"
        return 1
    fi

    # Extract service ID from output
    KOYEB_SERVICE_ID=$(echo "$create_output" | grep -oP 'Service \K[a-f0-9-]+' | head -1)

    if [[ -z "$KOYEB_SERVICE_ID" ]]; then
        # Fallback: try to get it from service list
        KOYEB_SERVICE_ID=$(koyeb service list --app "$app_name" 2>/dev/null | grep "$service_name" | awk '{print $1}' | head -1)
    fi

    log_info "Koyeb service created: $service_name (ID: $KOYEB_SERVICE_ID)"
}

# Wait for a Koyeb service to become healthy/running
# Usage: _koyeb_wait_for_service SERVICE_ID [MAX_ATTEMPTS]
_koyeb_wait_for_service() {
    local service_id="$1"
    local max_attempts=${2:-60}
    local attempt=0

    log_warn "Waiting for service to deploy..."
    while [[ $attempt -lt $max_attempts ]]; do
        local status
        status=$(koyeb service get "$service_id" 2>/dev/null | grep "Status:" | awk '{print $2}')

        if [[ "$status" == "healthy" || "$status" == "running" ]]; then
            log_info "Service is ready"
            return 0
        fi

        if [[ "$status" == "error" || "$status" == "failed" ]]; then
            log_error "Service deployment failed"
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 5
    done

    log_error "Timeout waiting for service to be ready"
    return 1
}

# Get the instance ID for a running Koyeb service
# Sets: KOYEB_INSTANCE_ID
# Usage: _koyeb_get_instance_id SERVICE_ID
_koyeb_get_instance_id() {
    local service_id="$1"

    KOYEB_INSTANCE_ID=$(koyeb instances list --service "$service_id" 2>/dev/null | grep -v "^ID" | awk '{print $1}' | head -1)

    if [[ -z "$KOYEB_INSTANCE_ID" ]]; then
        log_error "Failed to get instance ID"
        return 1
    fi

    log_info "Instance ID: $KOYEB_INSTANCE_ID"
}

# Create a Koyeb app and service
# Sets: KOYEB_APP_NAME, KOYEB_SERVICE_NAME, KOYEB_SERVICE_ID, KOYEB_INSTANCE_ID
create_server() {
    local name="${1:-$(get_server_name)}"

    KOYEB_APP_NAME="${name}"
    KOYEB_SERVICE_NAME="${name}-svc"

    _koyeb_create_app "$KOYEB_APP_NAME" || return 1
    _koyeb_create_service "$KOYEB_APP_NAME" "$KOYEB_SERVICE_NAME" || return 1
    _koyeb_wait_for_service "$KOYEB_SERVICE_ID" || return 1
    _koyeb_get_instance_id "$KOYEB_SERVICE_ID" || return 1
}

# Run a command on the Koyeb service instance
run_server() {
    local cmd="$1"

    if [[ -z "$KOYEB_INSTANCE_ID" ]]; then
        log_error "No instance ID set. Call create_server first."
        return 1
    fi

    koyeb instances exec "$KOYEB_INSTANCE_ID" -- bash -c "$cmd"
}

# Upload a file to the Koyeb instance via base64 encoding
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    if [[ ! -f "$local_path" ]]; then
        log_error "Local file not found: $local_path"
        return 1
    fi

    # SECURITY: base64 -w0 produces single-line output (no newline injection)
    local content
    content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")

    # SECURITY: Properly escape remote_path to prevent injection
    local escaped_path
    escaped_path=$(printf '%q' "$remote_path")

    # base64 output is safe (alphanumeric + /+=) so no injection risk
    run_server "printf '%s' '$content' | base64 -d > $escaped_path"
}

# Wait for cloud-init or basic system readiness
wait_for_cloud_init() {
    log_warn "Installing base tools..."

    # Update package lists and install essentials
    run_server "apt-get update -qq && apt-get install -y -qq curl wget git python3 python3-pip build-essential ca-certificates" || {
        log_error "Failed to install base tools"
        return 1
    }

    log_info "Base tools installed"
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

    # Upload and append to .bashrc (Koyeb containers use bash, not zsh)
    upload_file "${env_temp}" "/tmp/env_config"
    run_server "cat /tmp/env_config >> /root/.bashrc && rm /tmp/env_config"

    log_info "Environment variables configured"
}

# Start an interactive session
interactive_session() {
    local launch_cmd="${1:-bash}"

    if [[ -z "$KOYEB_INSTANCE_ID" ]]; then
        log_error "No instance ID set. Call create_server first."
        return 1
    fi

    log_info "Starting interactive session..."
    koyeb instances exec "$KOYEB_INSTANCE_ID" -- bash -c "$launch_cmd"
}

# Cleanup: delete the service and app
cleanup_server() {
    if [[ -n "${KOYEB_SERVICE_NAME:-}" ]]; then
        log_warn "Deleting service: $KOYEB_SERVICE_NAME"
        koyeb service delete "$KOYEB_SERVICE_NAME" --force >/dev/null 2>&1 || true
    fi

    if [[ -n "${KOYEB_APP_NAME:-}" ]]; then
        log_warn "Deleting app: $KOYEB_APP_NAME"
        koyeb app delete "$KOYEB_APP_NAME" >/dev/null 2>&1 || true
    fi
}
