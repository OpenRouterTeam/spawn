#!/bin/bash
# Cherry Servers-specific functions for Spawn

# Source shared provider-agnostic functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# ============================================================
# Cherry Servers Configuration
# ============================================================

CHERRY_API_BASE="https://api.cherryservers.com/v1"
CHERRY_DEFAULT_PLAN="${CHERRY_DEFAULT_PLAN:-cloud_vps_1}"
CHERRY_DEFAULT_REGION="${CHERRY_DEFAULT_REGION:-eu_nord_1}"
CHERRY_DEFAULT_IMAGE="${CHERRY_DEFAULT_IMAGE:-Ubuntu 24.04 64bit}"

# ============================================================
# Authentication
# ============================================================

# Get Cherry Servers API token
ensure_cherry_token() {
    local token="${CHERRY_AUTH_TOKEN:-}"

    if [[ -z "$token" ]]; then
        log_warn "CHERRY_AUTH_TOKEN not found in environment"
        log_info "Get your API token from: https://portal.cherryservers.com/"
        printf "Enter your Cherry Servers API token: "
        read -r token
    fi

    if [[ -z "$token" ]]; then
        log_error "API token is required"
        exit 1
    fi

    CHERRY_AUTH_TOKEN="$token"
    export CHERRY_AUTH_TOKEN
}

# ============================================================
# SSH Key Management
# ============================================================

# Ensure SSH key exists and is registered with Cherry Servers
ensure_ssh_key() {
    check_python_available
    generate_ssh_key_if_missing

    local ssh_pub_key
    ssh_pub_key=$(cat ~/.ssh/id_rsa.pub)

    # Check if key already exists
    log_info "Checking for existing SSH key in Cherry Servers..."

    local existing_keys
    existing_keys=$(curl -s -X GET \
        -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
        -H "Content-Type: application/json" \
        "${CHERRY_API_BASE}/ssh-keys" 2>&1)

    local key_fingerprint
    key_fingerprint=$(get_ssh_fingerprint)

    # Check if our key is already registered
    local key_id
    key_id=$(printf '%s' "$existing_keys" | python3 -c "
import sys, json
try:
    keys = json.load(sys.stdin)
    fingerprint = '${key_fingerprint}'
    for key in keys:
        if key.get('fingerprint', '') == fingerprint:
            print(key.get('id', ''))
            break
except:
    pass
" 2>&1)

    if [[ -n "$key_id" ]]; then
        log_info "SSH key already registered (ID: $key_id)"
        CHERRY_SSH_KEY_ID="$key_id"
        export CHERRY_SSH_KEY_ID
        return 0
    fi

    # Register new SSH key
    log_info "Registering new SSH key with Cherry Servers..."

    local label="spawn-$(date +%s)"
    local response
    response=$(curl -s -X POST \
        -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"label\": \"$label\", \"key\": \"$ssh_pub_key\"}" \
        "${CHERRY_API_BASE}/ssh-keys" 2>&1)

    key_id=$(printf '%s' "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('id', ''))
except:
    pass
" 2>&1)

    if [[ -z "$key_id" ]]; then
        log_error "Failed to register SSH key"
        log_error "Response: $response"
        exit 1
    fi

    log_info "SSH key registered successfully (ID: $key_id)"
    CHERRY_SSH_KEY_ID="$key_id"
    export CHERRY_SSH_KEY_ID
}

# ============================================================
# Server Management
# ============================================================

# Get project ID (required for server creation)
get_cherry_project_id() {
    check_python_available

    local projects
    projects=$(curl -s -X GET \
        -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
        -H "Content-Type: application/json" \
        "${CHERRY_API_BASE}/projects" 2>&1)

    local project_id
    project_id=$(printf '%s' "$projects" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list) and len(data) > 0:
        print(data[0].get('id', ''))
except:
    pass
" 2>&1)

    if [[ -z "$project_id" ]]; then
        log_error "No project found in Cherry Servers account"
        log_error "Create a project at https://portal.cherryservers.com/"
        exit 1
    fi

    printf '%s' "$project_id"
}

# Get server name (generate or prompt)
get_server_name() {
    local server_name="${CHERRY_SERVER_NAME:-}"

    if [[ -z "$server_name" ]]; then
        server_name="spawn-$(date +%s)"
    fi

    printf '%s' "$server_name"
}

# Create server
# Sets CHERRY_SERVER_ID and CHERRY_SERVER_IP as exports
create_server() {
    local hostname="$1"
    local plan="${CHERRY_DEFAULT_PLAN}"
    local region="${CHERRY_DEFAULT_REGION}"
    local image="${CHERRY_DEFAULT_IMAGE}"

    check_python_available

    local project_id
    project_id=$(get_cherry_project_id)

    log_info "Creating Cherry Servers server..."
    log_info "Plan: $plan, Region: $region, Image: $image"

    local payload
    payload=$(python3 -c "
import json
data = {
    'plan': '$plan',
    'region': '$region',
    'image': '$image',
    'hostname': '$hostname',
    'ssh_keys': [${CHERRY_SSH_KEY_ID}]
}
print(json.dumps(data))
")

    local response
    response=$(curl -s -X POST \
        -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "${CHERRY_API_BASE}/projects/${project_id}/servers" 2>&1)

    local server_id
    server_id=$(printf '%s' "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('id', ''))
except:
    pass
" 2>&1)

    if [[ -z "$server_id" ]]; then
        log_error "Failed to create server"
        log_error "Response: $response"
        exit 1
    fi

    log_info "Server created with ID: $server_id"
    CHERRY_SERVER_ID="$server_id"
    export CHERRY_SERVER_ID

    # Wait for IP assignment
    log_info "Waiting for IP address assignment..."
    local ip_address=""
    local attempts=0
    local max_attempts=60

    while [[ -z "$ip_address" ]] && [[ $attempts -lt $max_attempts ]]; do
        sleep "${POLL_INTERVAL}"

        local server_info
        server_info=$(curl -s -X GET \
            -H "Authorization: Bearer ${CHERRY_AUTH_TOKEN}" \
            -H "Content-Type: application/json" \
            "${CHERRY_API_BASE}/servers/${server_id}" 2>&1)

        ip_address=$(printf '%s' "$server_info" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    addresses = data.get('ip_addresses', [])
    for addr in addresses:
        if addr.get('type') == 'primary-ip':
            print(addr.get('address', ''))
            break
except:
    pass
" 2>&1)

        attempts=$((attempts + 1))
    done

    if [[ -z "$ip_address" ]]; then
        log_error "Failed to get server IP address"
        exit 1
    fi

    log_info "Server IP: $ip_address"
    CHERRY_SERVER_IP="$ip_address"
    export CHERRY_SERVER_IP
}

# ============================================================
# Execution Functions
# ============================================================

# Run command on server via SSH
run_server() {
    local ip="$1"
    local command="$2"

    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=10 \
        "root@${ip}" "$command"
}

# Upload file to server via SCP
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"

    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=10 \
        "$local_path" "root@${ip}:${remote_path}"
}

# Start interactive SSH session
interactive_session() {
    local ip="$1"
    local command="${2:-}"

    if [[ -n "$command" ]]; then
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o LogLevel=ERROR -t \
            "root@${ip}" "$command"
    else
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o LogLevel=ERROR -t \
            "root@${ip}"
    fi
}

# ============================================================
# Connectivity and Readiness
# ============================================================

# Verify server is accessible via SSH
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=60
    local attempt=0

    log_info "Waiting for SSH connectivity..."

    while [[ $attempt -lt $max_attempts ]]; do
        if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
               -o LogLevel=ERROR -o ConnectTimeout=5 \
               "root@${ip}" "echo 'SSH ready'" &> /dev/null; then
            log_info "SSH connection established"
            return 0
        fi

        attempt=$((attempt + 1))
        sleep "${POLL_INTERVAL}"
    done

    log_error "Failed to connect to server via SSH"
    exit 1
}

# Wait for cloud-init to complete
wait_for_cloud_init() {
    local ip="$1"
    local timeout="${2:-300}"

    log_info "Waiting for system initialization..."

    if ! run_server "$ip" "cloud-init status --wait --long" 2>/dev/null; then
        log_warn "cloud-init wait timed out or not available, proceeding anyway"
    else
        log_info "System initialization complete"
    fi
}
