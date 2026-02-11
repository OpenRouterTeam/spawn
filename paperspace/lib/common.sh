#!/bin/bash
set -eo pipefail
# Common bash functions for Paperspace spawn scripts

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
# Paperspace specific functions
# ============================================================

readonly PAPERSPACE_API_BASE="https://api.paperspace.com/v1"
readonly DEFAULT_MACHINE_TYPE="${PAPERSPACE_MACHINE_TYPE:-C4}"
readonly DEFAULT_REGION="${PAPERSPACE_REGION:-NY2}"
readonly DEFAULT_DISK_SIZE="${PAPERSPACE_DISK_SIZE:-50}"

# Ensure pspace CLI is installed
ensure_pspace_installed() {
    if ! command -v pspace &> /dev/null; then
        log_warn "pspace CLI not found, installing..."
        curl -fsSL https://www.paperspace.com/install.sh | sh

        # Verify installation
        if ! command -v pspace &> /dev/null; then
            log_error "Failed to install pspace CLI"
            log_error "Please install manually: curl -fsSL https://www.paperspace.com/install.sh | sh"
            return 1
        fi
        log_info "pspace CLI installed successfully"
    fi
    return 0
}

# Test Paperspace API key
test_paperspace_api_key() {
    local response
    response=$(curl -fsSL -H "Authorization: Bearer ${PAPERSPACE_API_KEY}" \
        "${PAPERSPACE_API_BASE}/machines" 2>&1)

    if echo "$response" | grep -qi "unauthorized\|forbidden\|invalid"; then
        log_error "API authentication failed"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Go to https://console.paperspace.com/account/api"
        log_error "  2. Create a new API key if you don't have one"
        log_error "  3. Copy the API key and set it as PAPERSPACE_API_KEY"
        return 1
    fi
    return 0
}

# Ensure PAPERSPACE_API_KEY is available (env var → config file → prompt+save)
ensure_paperspace_api_key() {
    ensure_api_token_with_provider \
        "Paperspace" \
        "PAPERSPACE_API_KEY" \
        "$HOME/.config/spawn/paperspace.json" \
        "https://console.paperspace.com/account/api" \
        "test_paperspace_api_key"
}

# Get machine name from env var or prompt
get_machine_name() {
    local machine_name
    machine_name=$(get_resource_name "PAPERSPACE_MACHINE_NAME" "Enter machine name: ") || return 1

    if ! validate_server_name "$machine_name"; then
        return 1
    fi

    echo "$machine_name"
}

# Get or find a suitable template ID for Ubuntu
get_ubuntu_template() {
    # Try to list templates and find Ubuntu 22.04 or 20.04
    local templates
    templates=$(curl -fsSL -H "Authorization: Bearer ${PAPERSPACE_API_KEY}" \
        "${PAPERSPACE_API_BASE}/templates" 2>/dev/null || echo "")

    # Try to extract Ubuntu 22.04 template first, then 20.04
    local template_id
    template_id=$(echo "$templates" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    templates = data if isinstance(data, list) else data.get('templates', [])
    # Prefer Ubuntu 22.04
    for t in templates:
        if 'ubuntu' in t.get('name', '').lower() and '22.04' in t.get('name', ''):
            print(t.get('id', ''))
            exit(0)
    # Fallback to Ubuntu 20.04
    for t in templates:
        if 'ubuntu' in t.get('name', '').lower() and '20.04' in t.get('name', ''):
            print(t.get('id', ''))
            exit(0)
except:
    pass
" 2>/dev/null || echo "")

    # If we found a template, use it
    if [[ -n "$template_id" ]]; then
        echo "$template_id"
        return 0
    fi

    # Fallback to a known Ubuntu template ID (this may need updating)
    echo "tx98gvxz"  # Common Ubuntu template
}

# Ensure SSH key exists locally and get public key
ensure_ssh_key() {
    ensure_ssh_key_with_provider "" "" "Paperspace"
}

# Create a Paperspace machine
create_machine() {
    local name="$1"
    local machine_type="${DEFAULT_MACHINE_TYPE}"
    local region="${DEFAULT_REGION}"
    local disk_size="${DEFAULT_DISK_SIZE}"

    log_warn "Creating Paperspace machine '$name' (type: $machine_type, region: $region, disk: ${disk_size}GB)..."

    # Get SSH public key
    local ssh_pub_key
    ssh_pub_key=$(cat ~/.ssh/spawn-ed25519.pub)

    # Get template ID
    local template_id
    template_id=$(get_ubuntu_template)
    log_info "Using template ID: $template_id"

    # Create startup script for cloud-init-like setup
    local startup_script
    startup_script=$(get_cloud_init_userdata)

    # Create a temporary file for the startup script
    local script_file="/tmp/paperspace-startup-$$.sh"
    echo "$startup_script" > "$script_file"

    # Create machine using pspace CLI
    # Note: pspace doesn't support all the flags we need, so we'll use the API
    local create_response
    create_response=$(curl -fsSL -X POST \
        -H "Authorization: Bearer ${PAPERSPACE_API_KEY}" \
        -H "Content-Type: application/json" \
        "${PAPERSPACE_API_BASE}/machines" \
        -d "$(python3 -c "
import json, sys
data = {
    'name': '$name',
    'machineType': '$machine_type',
    'region': '$region',
    'size': $disk_size,
    'templateId': '$template_id',
    'billingType': 'hourly',
    'startOnCreate': True
}
print(json.dumps(data))
")" 2>&1)

    # Clean up temp file
    rm -f "$script_file"

    # Check for errors
    if echo "$create_response" | grep -qi "error\|failed"; then
        log_error "Failed to create machine:"
        log_error "$create_response"
        return 1
    fi

    # Extract machine ID and IP
    export PAPERSPACE_MACHINE_ID=$(echo "$create_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('id', ''))
except:
    pass
" 2>/dev/null || echo "")

    if [[ -z "$PAPERSPACE_MACHINE_ID" ]]; then
        log_error "Failed to get machine ID from response"
        return 1
    fi

    log_info "Machine created with ID: $PAPERSPACE_MACHINE_ID"
    log_warn "Waiting for machine to start..."

    # Wait for machine to be ready and get IP
    local retries=60
    while [[ $retries -gt 0 ]]; do
        local machine_info
        machine_info=$(curl -fsSL -H "Authorization: Bearer ${PAPERSPACE_API_KEY}" \
            "${PAPERSPACE_API_BASE}/machines/${PAPERSPACE_MACHINE_ID}" 2>/dev/null || echo "")

        local state
        state=$(echo "$machine_info" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('state', ''))
except:
    pass
" 2>/dev/null || echo "")

        if [[ "$state" == "ready" ]]; then
            export PAPERSPACE_MACHINE_IP=$(echo "$machine_info" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('publicIpAddress', ''))
except:
    pass
" 2>/dev/null || echo "")

            if [[ -n "$PAPERSPACE_MACHINE_IP" ]]; then
                log_info "Machine is ready! IP: $PAPERSPACE_MACHINE_IP"
                return 0
            fi
        fi

        sleep 5
        retries=$((retries - 1))
    done

    log_error "Machine failed to become ready in time"
    return 1
}

# Verify server connectivity via SSH
verify_server_connectivity() {
    local ip="$1"
    generic_ssh_wait "$ip" "root" 60
}

# Run command on Paperspace machine
run_server() {
    local ip="$1"
    shift
    ssh ${SSH_OPTS} root@"${ip}" "$@"
}

# Upload file to Paperspace machine
upload_file() {
    local ip="$1"
    local src="$2"
    local dest="$3"
    scp ${SSH_OPTS} "$src" root@"${ip}":"$dest"
}

# Start interactive session
interactive_session() {
    local ip="$1"
    local cmd="${2:-bash}"
    ssh -t ${SSH_OPTS} root@"${ip}" "$cmd"
}

# Wait for cloud-init to complete
wait_for_cloud_init() {
    local ip="$1"
    local timeout="${2:-300}"

    log_warn "Waiting for system initialization (timeout: ${timeout}s)..."
    local elapsed=0
    while [[ $elapsed -lt $timeout ]]; do
        if run_server "$ip" "command -v curl" >/dev/null 2>&1; then
            log_info "System initialization complete"
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done

    log_error "System initialization timed out"
    return 1
}

# Delete Paperspace machine
delete_machine() {
    local machine_id="${1:-${PAPERSPACE_MACHINE_ID}}"

    if [[ -z "$machine_id" ]]; then
        log_warn "No machine ID provided, skipping deletion"
        return 0
    fi

    log_warn "Deleting machine $machine_id..."
    curl -fsSL -X DELETE \
        -H "Authorization: Bearer ${PAPERSPACE_API_KEY}" \
        "${PAPERSPACE_API_BASE}/machines/${machine_id}" >/dev/null 2>&1 || true

    log_info "Machine deletion initiated"
}
