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

SPAWN_DASHBOARD_URL="https://app.koyeb.com/"

# Detect OS name for binary downloads (darwin or linux)
# Outputs the OS name to stdout; returns 1 on unsupported OS
_koyeb_detect_os() {
    case "$(uname -s)" in
        Darwin) echo "darwin" ;;
        Linux) echo "linux" ;;
        *)
            log_error "Unsupported operating system: $(uname -s)"
            return 1
            ;;
    esac
}

# Detect CPU architecture for binary downloads (amd64 or arm64)
# Outputs the arch name to stdout; returns 1 on unsupported architecture
_koyeb_detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64) echo "amd64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)
            log_error "Unsupported architecture: $(uname -m)"
            return 1
            ;;
    esac
}

# Download and install the Koyeb CLI binary
# Usage: _koyeb_install_cli OS ARCH
_koyeb_install_cli() {
    local os="$1" arch="$2"
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
}

# Ensure Koyeb CLI is installed
ensure_koyeb_cli() {
    if command -v koyeb &>/dev/null; then
        log_info "Koyeb CLI available"
        return 0
    fi

    log_step "Installing Koyeb CLI..."

    local os arch
    os=$(_koyeb_detect_os) || return 1
    arch=$(_koyeb_detect_arch) || return 1

    _koyeb_install_cli "$os" "$arch" || return 1

    log_info "Koyeb CLI installed"
}

# Ensure KOYEB_TOKEN is available (env var -> config file -> prompt+save)
ensure_koyeb_token() {
    ensure_api_token_with_provider \
        "Koyeb" \
        "KOYEB_TOKEN" \
        "$HOME/.config/spawn/koyeb.json" \
        "https://app.koyeb.com/account/api"
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
    log_step "Creating Koyeb app: $app_name"
    local create_output
    create_output=$(koyeb app create "$app_name" 2>&1)
    if [[ $? -ne 0 ]]; then
        log_error "Failed to create Koyeb app '$app_name'"
        if [[ -n "$create_output" ]]; then
            log_error "Error: $create_output"
        fi
        log_error ""
        log_error "Common causes:"
        log_error "  - App name already taken by another user"
        log_error "  - Invalid app name (must be lowercase alphanumeric with hyphens)"
        log_error "  - API token lacks permissions"
        log_error "Check your dashboard: https://app.koyeb.com/"
        return 1
    fi
}

# Create a Koyeb service and extract its ID
# Sets: KOYEB_SERVICE_ID
# Usage: _koyeb_create_service APP_NAME SERVICE_NAME
_koyeb_create_service() {
    local app_name="$1"
    local service_name="$2"

    log_step "Creating Koyeb service: $service_name"

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
        log_error "Failed to create Koyeb service '$service_name'"
        log_error "$create_output"
        log_error ""
        log_error "Common causes:"
        log_error "  - Insufficient account balance or payment method required"
        log_error "  - Region unavailable (try a different region)"
        log_error "  - Instance type not available"
        log_error "Check your dashboard: https://app.koyeb.com/"
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

    log_step "Waiting for service to deploy..."
    while [[ $attempt -lt $max_attempts ]]; do
        local status
        status=$(koyeb service get "$service_id" 2>/dev/null | grep "Status:" | awk '{print $2}')

        if [[ "$status" == "healthy" || "$status" == "running" ]]; then
            log_info "Service is ready"
            return 0
        fi

        if [[ "$status" == "error" || "$status" == "failed" ]]; then
            log_error "Service deployment failed with status: $status"
            log_error ""
            log_error "Common causes:"
            log_error "  - Docker image pull failure (check image name and registry access)"
            log_error "  - Insufficient resources for the selected instance type"
            log_error "  - Health check failure (service crashed on startup)"
            log_error "  - Application error in startup command"
            log_error ""
            log_error "Debugging steps:"
            log_error "  1. View deployment logs at: https://app.koyeb.com/"
            log_error "  2. Check service details: koyeb service get $service_id"
            log_error "  3. Try a different region or instance type"
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 5
    done

    log_error "Service did not become ready after $((max_attempts * 5))s"
    log_error ""
    log_error "The service may still be deploying. You can:"
    log_error "  1. Check status at: https://app.koyeb.com/"
    log_error "  2. Re-run the command to try again"
    return 1
}

# Get the instance ID for a running Koyeb service
# Sets: KOYEB_INSTANCE_ID
# Usage: _koyeb_get_instance_id SERVICE_ID
_koyeb_get_instance_id() {
    local service_id="$1"

    KOYEB_INSTANCE_ID=$(koyeb instances list --service "$service_id" 2>/dev/null | grep -v "^ID" | awk '{print $1}' | head -1)

    if [[ -z "$KOYEB_INSTANCE_ID" ]]; then
        log_error "Failed to get instance ID for service $service_id"
        log_error ""
        log_error "The service may not have any running instances yet."
        log_error "Check service status at: https://app.koyeb.com/"
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
# SECURITY: Uses printf %q to properly escape commands to prevent injection
run_server() {
    local cmd="$1"

    if [[ -z "$KOYEB_INSTANCE_ID" ]]; then
        log_error "No instance ID set. Call create_server first."
        return 1
    fi

    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    koyeb instances exec "$KOYEB_INSTANCE_ID" -- bash -c "$escaped_cmd"
}

# Upload a file to the Koyeb instance via base64 encoding
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    if [[ ! -f "$local_path" ]]; then
        log_error "Local file not found: $local_path"
        return 1
    fi

    # SECURITY: Strict allowlist validation — only safe path characters
    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    # SECURITY: base64 -w0 produces single-line output (no newline injection)
    # base64 output is safe (alphanumeric + /+=) so no injection risk
    local content
    content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")

    run_server "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Wait for cloud-init or basic system readiness
wait_for_cloud_init() {
    log_step "Installing base tools..."

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
    log_step "Injecting environment variables..."

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

    log_step "Starting interactive session..."
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$launch_cmd")
    local session_exit=0
    koyeb instances exec "$KOYEB_INSTANCE_ID" -- bash -c "$escaped_cmd" || session_exit=$?
    SERVER_NAME="${KOYEB_SERVICE_NAME:-}" _show_exec_post_session_summary
    return "${session_exit}"
}

# Cleanup: delete the service and app
cleanup_server() {
    if [[ -n "${KOYEB_SERVICE_NAME:-}" ]]; then
        log_step "Deleting service: $KOYEB_SERVICE_NAME"
        koyeb service delete "$KOYEB_SERVICE_NAME" --force >/dev/null 2>&1 || true
    fi

    if [[ -n "${KOYEB_APP_NAME:-}" ]]; then
        log_step "Deleting app: $KOYEB_APP_NAME"
        koyeb app delete "$KOYEB_APP_NAME" >/dev/null 2>&1 || true
    fi
}
