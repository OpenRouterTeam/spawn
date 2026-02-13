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

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

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
    check_ssh_key_by_fingerprint cherry_api "/ssh-keys" "$1"
}

# Register SSH key with Cherry Servers
cherry_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"label\":$json_name,\"key\":$json_pub_key}"
    local register_response
    register_response=$(cherry_api POST "/ssh-keys" "$register_body")

    if printf '%s' "$register_response" | grep -q '"id"'; then
        return 0
    else
        log_error "Failed to register SSH key with Cherry Servers"
        log_error "API Error: $(extract_api_error_message "$register_response" "$register_response")"
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
    project_id=$(_extract_json_field "$projects" "d[0]['id'] if isinstance(d,list) and d else ''")

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

# Poll the Cherry Servers API until the server is deployed and has an IP address
# Sets CHERRY_SERVER_IP on success
_cherry_wait_for_ip() {
    local server_id="$1"
    generic_wait_for_instance cherry_api "/servers/${server_id}" \
        "deployed" "d.get('status', 'unknown')" \
        "next((addr.get('address','') for addr in d.get('ip_addresses',[]) if addr.get('type')=='primary-ip'), '')" \
        CHERRY_SERVER_IP "Server" 60
}

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

    log_step "Creating Cherry Servers server..."
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
    server_id=$(_extract_json_field "$response" "d.get('id','')")

    if [[ -z "$server_id" ]]; then
        log_error "Failed to create Cherry Servers server"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Plan unavailable in region (try different CHERRY_DEFAULT_PLAN or CHERRY_DEFAULT_REGION)"
        log_warn "  - Server limit reached for your account"
        return 1
    fi

    log_info "Server created with ID: $server_id"
    CHERRY_SERVER_ID="$server_id"
    export CHERRY_SERVER_ID

    # Wait for IP assignment
    _cherry_wait_for_ip "$server_id"
}

# ============================================================
# Execution Functions
# ============================================================

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }
verify_server_connectivity() { ssh_verify_connectivity "$@"; }

# Wait for cloud-init to complete
wait_for_cloud_init() {
    local ip="$1"
    local timeout="${2:-300}"

    log_step "Waiting for system initialization..."

    if ! run_server "$ip" "cloud-init status --wait --long" 2>/dev/null; then
        log_warn "cloud-init wait timed out or not available, proceeding anyway"
    else
        log_info "System initialization complete"
    fi
}
