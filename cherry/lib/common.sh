#!/bin/bash
# Cherry Servers-specific functions for Spawn

# Source shared provider-agnostic functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
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
# JSON Helpers
# ============================================================

# Extract a field from a JSON object via stdin
# Usage: echo '{"id": 123}' | _cherry_json_field "id"
_cherry_json_field() {
    local field="$1"
    python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get(sys.argv[1], ''))
except:
    pass
" "$field" 2>&1
}

# Extract the primary IP address from a Cherry server info response
# Usage: echo '{"ip_addresses":[...]}' | _cherry_extract_primary_ip
_cherry_extract_primary_ip() {
    python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for addr in data.get('ip_addresses', []):
        if addr.get('type') == 'primary-ip':
            print(addr.get('address', ''))
            break
except:
    pass
" 2>&1
}

# ============================================================
# API Wrapper
# ============================================================

# Cherry Servers API wrapper - delegates to generic_cloud_api for retry logic
cherry_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$CHERRY_API_BASE" "$CHERRY_AUTH_TOKEN" "$method" "$endpoint" "$body"
}

# ============================================================
# Authentication
# ============================================================

# Test Cherry Servers API token
test_cherry_token() {
    local response
    response=$(cherry_api GET "/projects")
    printf '%s' "$response" | grep -q '"id"'
}

# Get Cherry Servers API token
ensure_cherry_token() {
    ensure_api_token_with_provider \
        "Cherry Servers" \
        "CHERRY_AUTH_TOKEN" \
        "$HOME/.config/spawn/cherry.json" \
        "https://portal.cherryservers.com/" \
        test_cherry_token
}

# ============================================================
# SSH Key Management
# ============================================================

# Check if SSH key is registered with Cherry Servers
cherry_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(cherry_api GET "/ssh-keys")
    printf '%s' "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Cherry Servers
cherry_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"label\":\"$key_name\",\"key\":$json_pub_key}"
    local register_response
    register_response=$(cherry_api POST "/ssh-keys" "$register_body")

    if printf '%s' "$register_response" | grep -q '"id"'; then
        return 0
    else
        log_error "Failed to register SSH key"
        log_error "Response: $register_response"
        return 1
    fi
}

# Ensure SSH key exists and is registered with Cherry Servers
ensure_ssh_key() {
    ensure_ssh_key_with_provider cherry_check_ssh_key cherry_register_ssh_key "Cherry Servers"
}

# ============================================================
# Server Management
# ============================================================

# Get project ID (required for server creation)
get_cherry_project_id() {
    check_python_available

    local projects
    projects=$(cherry_api GET "/projects")

    local project_id
    project_id=$(printf '%s' "$projects" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list) and len(data) > 0:
        print(data[0].get('id', ''))
except: pass
" 2>&1)

    if [[ -z "$project_id" ]]; then
        log_error "No project found in Cherry Servers account"
        log_error "Create a project at https://portal.cherryservers.com/"
        return 1
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

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$hostname" || { log_error "Invalid hostname"; return 1; }
    validate_resource_name "$plan" || { log_error "Invalid CHERRY_DEFAULT_PLAN"; return 1; }
    validate_resource_name "$region" || { log_error "Invalid CHERRY_DEFAULT_REGION"; return 1; }

    local project_id
    project_id=$(get_cherry_project_id) || return 1

    log_info "Creating Cherry Servers server..."
    log_info "Plan: $plan, Region: $region, Image: $image"

    local payload
    payload=$(python3 -c "
import json, sys
data = {
    'plan': sys.argv[1],
    'region': sys.argv[2],
    'image': sys.argv[3],
    'hostname': sys.argv[4],
    'ssh_keys': [int(sys.argv[5])]
}
print(json.dumps(data))
" "$plan" "$region" "$image" "$hostname" "${CHERRY_SSH_KEY_ID}")

    local response
    response=$(cherry_api POST "/projects/${project_id}/servers" "$payload")

    local server_id
    server_id=$(printf '%s' "$response" | _cherry_json_field "id")

    if [[ -z "$server_id" ]]; then
        log_error "Failed to create server"
        log_error "Response: $response"
        return 1
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
        server_info=$(cherry_api GET "/servers/${server_id}")

        ip_address=$(printf '%s' "$server_info" | _cherry_extract_primary_ip)

        attempts=$((attempts + 1))
    done

    if [[ -z "$ip_address" ]]; then
        log_error "Failed to get server IP address"
        return 1
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
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@${ip}" "$cmd"
}

# Upload file to server via SCP
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@${ip}:${remote_path}"
}

# Start interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="${2:-}"
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "root@${ip}" $cmd
}

# ============================================================
# Connectivity and Readiness
# ============================================================

# Verify server is accessible via SSH
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-60}
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
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
