#!/bin/bash
# Common bash functions for Exoscale spawn scripts

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
# Exoscale specific functions
# ============================================================

# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

# Ensure exo CLI is installed
ensure_exo_cli() {
    if command -v exo &>/dev/null; then
        log_info "exo CLI is already installed"
        return 0
    fi

    log_step "exo CLI not found, installing..."

    # Detect OS and architecture
    local os arch exo_url
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)

    case "$arch" in
        x86_64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) log_error "Unsupported architecture: $arch"; return 1 ;;
    esac

    case "$os" in
        linux|darwin) ;;
        *) log_error "Unsupported OS: $os"; return 1 ;;
    esac

    # Latest version as of 2026-02
    local version="1.90.1"
    exo_url="https://github.com/exoscale/cli/releases/download/v${version}/exoscale-cli_${version}_${os}_${arch}.tar.gz"

    log_step "Downloading exo CLI from GitHub..."
    local temp_dir
    temp_dir=$(mktemp -d)
    if ! curl -fsSL "$exo_url" -o "${temp_dir}/exo.tar.gz"; then
        log_error "Failed to download exo CLI"
        rm -rf "$temp_dir"
        return 1
    fi

    tar -xzf "${temp_dir}/exo.tar.gz" -C "${temp_dir}"
    sudo mv "${temp_dir}/exo" /usr/local/bin/exo
    sudo chmod +x /usr/local/bin/exo
    rm -rf "$temp_dir"

    log_info "exo CLI installed successfully"
}

# Test Exoscale API credentials
test_exoscale_creds() {
    if ! exo config list &>/dev/null; then
        log_error "Exoscale credentials not configured or invalid"
        return 1
    fi

    log_info "Exoscale credentials validated"
    return 0
}

# Ensure Exoscale credentials are configured
ensure_exoscale_creds() {
    check_python_available || return 1
    ensure_exo_cli || return 1

    # Check if credentials are already configured
    if exo config list &>/dev/null 2>&1; then
        log_info "Using existing Exoscale configuration"
        return 0
    fi

    # Check for environment variables
    if [[ -n "${EXOSCALE_API_KEY:-}" && -n "${EXOSCALE_API_SECRET:-}" ]]; then
        log_info "Using Exoscale credentials from environment"
        local zone="${EXOSCALE_ZONE:-ch-gva-2}"
        exo config add default \
            --api-key "${EXOSCALE_API_KEY}" \
            --api-secret "${EXOSCALE_API_SECRET}" \
            --default-zone "$zone"
        return 0
    fi

    # Prompt for credentials
    log_step "Exoscale credentials not found"
    log_step "Get your API credentials at: https://portal.exoscale.com/iam/api-keys"
    echo ""

    local api_key api_secret zone
    api_key=$(safe_read "Enter Exoscale API Key: ") || return 1
    api_secret=$(safe_read "Enter Exoscale API Secret: ") || return 1
    zone=$(safe_read "Enter default zone [ch-gva-2]: ") || return 1
    zone="${zone:-ch-gva-2}"

    # Configure exo CLI
    exo config add default \
        --api-key "$api_key" \
        --api-secret "$api_secret" \
        --default-zone "$zone"

    if test_exoscale_creds; then
        log_info "Exoscale credentials configured successfully"
        return 0
    else
        log_error "Failed to configure Exoscale credentials"
        return 1
    fi
}

# Check if SSH key is registered with Exoscale
exoscale_check_ssh_key() {
    local fingerprint="$1"
    exo compute ssh-key list -O json | grep -q "$fingerprint"
}

# Register SSH key with Exoscale
exoscale_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"

    log_step "Registering SSH key '$key_name' with Exoscale..."
    if exo compute ssh-key register "$key_name" "$pub_path"; then
        log_info "SSH key registered successfully"
        return 0
    else
        log_error "Failed to register SSH key"
        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider exoscale_check_ssh_key exoscale_register_ssh_key "Exoscale"
}

get_server_name() {
    get_validated_server_name "EXOSCALE_SERVER_NAME" "Enter server name: "
}

# Wait for Exoscale instance to become running and get its IP
# Sets: EXOSCALE_SERVER_IP
# Usage: _wait_for_exoscale_instance INSTANCE_ID [MAX_ATTEMPTS]
_wait_for_exoscale_instance() {
    local instance_id="$1"
    local max_attempts=${2:-60}
    local attempt=1

    log_step "Waiting for instance to become running..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_json
        status_json=$(exo compute instance show "$instance_id" -O json 2>/dev/null || echo '{}')

        local status
        status=$(echo "$status_json" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('state','unknown'))" 2>/dev/null || echo "unknown")

        if [[ "$status" == "running" ]]; then
            EXOSCALE_SERVER_IP=$(echo "$status_json" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('public-ip',''))" 2>/dev/null)
            export EXOSCALE_SERVER_IP
            if [[ -n "$EXOSCALE_SERVER_IP" ]]; then
                log_info "Instance running: IP=$EXOSCALE_SERVER_IP"
                return 0
            fi
        fi

        log_step "Instance status: $status ($attempt/$max_attempts)"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become running in time"
    return 1
}

# Write cloud-init userdata to a temporary file for exo CLI
# Outputs the temp file path; caller is responsible for cleanup
_write_cloud_init_tempfile() {
    local userdata_file
    userdata_file=$(mktemp)
    get_cloud_init_userdata > "$userdata_file"
    echo "$userdata_file"
}

# Handle Exoscale instance creation error output
# Usage: _handle_exoscale_create_error OUTPUT
_handle_exoscale_create_error() {
    local create_output="$1"

    log_error "Failed to create Exoscale instance"
    log_error "Output: $create_output"
    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Instance type/zone unavailable"
    log_warn "  - Template not found"
    log_warn "  - SSH key not registered"
    log_warn "Remediation: Check https://portal.exoscale.com/"
}

create_server() {
    local name="$1"
    local instance_type="${EXOSCALE_INSTANCE_TYPE:-standard.small}"
    local zone="${EXOSCALE_ZONE:-ch-gva-2}"
    local template="${EXOSCALE_TEMPLATE:-Linux Ubuntu 24.04 LTS 64-bit}"

    # Validate env var inputs
    validate_resource_name "$instance_type" || { log_error "Invalid EXOSCALE_INSTANCE_TYPE"; return 1; }
    validate_region_name "$zone" || { log_error "Invalid EXOSCALE_ZONE"; return 1; }

    log_step "Creating Exoscale instance '$name' (type: $instance_type, zone: $zone)..."

    local ssh_key_name="spawn-${USER}-$(hostname)"

    local userdata_file
    userdata_file=$(_write_cloud_init_tempfile)

    # Create instance via exo CLI
    local create_output
    create_output=$(exo compute instance create "$name" \
        --zone "$zone" \
        --instance-type "$instance_type" \
        --template "$template" \
        --ssh-key "$ssh_key_name" \
        --cloud-init "$userdata_file" 2>&1)

    rm -f "$userdata_file"

    if ! echo "$create_output" | grep -q "success"; then
        _handle_exoscale_create_error "$create_output"
        return 1
    fi

    EXOSCALE_SERVER_ID=$(echo "$create_output" | grep -oP 'ID:\s+\K[a-f0-9-]+' | head -1)
    export EXOSCALE_SERVER_ID
    log_info "Instance created: ID=$EXOSCALE_SERVER_ID"

    _wait_for_exoscale_instance "$EXOSCALE_SERVER_ID"
}

# Exoscale Ubuntu images use 'ubuntu' user
SSH_USER="ubuntu"

# SSH operations — delegates to shared helpers
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    log_step "Destroying instance $server_id..."
    exo compute instance delete "$server_id" --force
    log_info "Instance $server_id destroyed"
}

list_servers() {
    exo compute instance list
}
