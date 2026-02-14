#!/bin/bash
# Common bash functions for BinaryLane spawn scripts

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

# Note: Provider-agnostic functions (logging, OAuth, browser, etc) are now in shared/common.sh

# ============================================================
# BinaryLane specific functions
# ============================================================

readonly BINARYLANE_API_BASE="https://api.binarylane.com.au/v2"
SPAWN_DASHBOARD_URL="https://manage.binarylane.com.au/"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

binarylane_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$BINARYLANE_API_BASE" "$BINARYLANE_API_TOKEN" "$method" "$endpoint" "$body"
}

test_binarylane_token() {
    local response
    response=$(binarylane_api GET "/account")
    if echo "$response" | grep -q '"account"'; then
        return 0
    fi
    local error_msg
    error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
    log_error "API Error: $error_msg"
    log_error ""
    log_error "How to fix:"
    log_error "  1. Verify API token at: https://home.binarylane.com.au/api-info"
    log_error "  2. Ensure the token has read/write permissions"
    log_error "  3. Check token hasn't been revoked"
    return 1
}

ensure_binarylane_token() {
    ensure_api_token_with_provider \
        "BinaryLane" \
        "BINARYLANE_API_TOKEN" \
        "$HOME/.config/spawn/binarylane.json" \
        "https://home.binarylane.com.au/api-info" \
        "test_binarylane_token"
}

# Check if SSH key is registered with BinaryLane
binarylane_check_ssh_key() {
    check_ssh_key_by_fingerprint binarylane_api "/account/keys" "$1"
}

# Register SSH key with BinaryLane
binarylane_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(binarylane_api POST "/account/keys" "$register_body")

    if echo "$register_response" | grep -q '"ssh_key"'; then
        return 0
    else
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider binarylane_check_ssh_key binarylane_register_ssh_key "BinaryLane"
}

get_server_name() {
    get_validated_server_name "BINARYLANE_SERVER_NAME" "Enter server name: "
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Poll the BinaryLane API until the server becomes active and has an IP
# Sets BINARYLANE_SERVER_IP on success
_binarylane_wait_for_active() {
    generic_wait_for_instance binarylane_api "/servers/$BINARYLANE_SERVER_ID" \
        "active" "d['server']['status']" \
        "next(n['ip_address'] for n in d['server']['networks']['v4'] if n['type']=='public')" \
        BINARYLANE_SERVER_IP "Server" 60
}

# Build JSON request body for BinaryLane server creation
# Usage: _binarylane_build_server_body NAME REGION SIZE IMAGE SSH_KEY_IDS
_binarylane_build_server_body() {
    local name="$1" region="$2" size="$3" image="$4" ssh_key_ids="$5"

    local userdata
    userdata=$(get_cloud_init_userdata)
    local json_userdata
    json_userdata=$(json_escape "$userdata")

    python3 -c "
import json, sys
userdata = json.loads(sys.stdin.read())
name, region, size, image, ssh_key_ids = sys.argv[1:6]
body = {
    'name': name,
    'region': region,
    'size': size,
    'image': image,
    'ssh_keys': json.loads(ssh_key_ids),
    'user_data': userdata,
    'backups': False
}
print(json.dumps(body))
" "$name" "$region" "$size" "$image" "$ssh_key_ids" <<< "$json_userdata"
}

# Parse server ID from create response, or log error and return 1
# Sets BINARYLANE_SERVER_ID on success
_binarylane_handle_create_response() {
    local response="$1"

    if echo "$response" | grep -q '"server"'; then
        BINARYLANE_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
        export BINARYLANE_SERVER_ID
        log_info "Server created: ID=$BINARYLANE_SERVER_ID"
        return 0
    fi

    log_error "Failed to create BinaryLane server"
    local error_msg
    error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$response")
    log_error "API Error: $error_msg"
    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Size/region/image unavailable (try different BINARYLANE_SIZE, BINARYLANE_REGION, or BINARYLANE_IMAGE)"
    log_warn "  - Server limit reached"
    log_warn "  - Invalid cloud-init userdata"
    log_warn "Check your dashboard: https://home.binarylane.com.au/"
    return 1
}

create_server() {
    local name="$1"
    local size="${BINARYLANE_SIZE:-std-1vcpu}"
    local region="${BINARYLANE_REGION:-syd}"
    local image="${BINARYLANE_IMAGE:-ubuntu-24.04}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$size" || { log_error "Invalid BINARYLANE_SIZE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid BINARYLANE_REGION"; return 1; }
    validate_resource_name "$image" || { log_error "Invalid BINARYLANE_IMAGE"; return 1; }

    log_step "Creating BinaryLane server '$name' (size: $size, region: $region, image: $image)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(binarylane_api GET "/account/keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    # Build request body and create server
    local body
    body=$(_binarylane_build_server_body "$name" "$region" "$size" "$image" "$ssh_key_ids")

    local response
    response=$(binarylane_api POST "/servers" "$body")

    _binarylane_handle_create_response "$response" || return 1

    # Wait for server to become active with IP
    _binarylane_wait_for_active
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    log_step "Destroying server $server_id..."
    binarylane_api DELETE "/servers/$server_id"
    log_info "Server $server_id destroyed"
}

list_servers() {
    local response
    response=$(binarylane_api GET "/servers")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<10} {'STATUS':<12} {'IP':<16} {'SIZE':<15} {'REGION':<10}\")
print('-' * 98)
for s in servers:
    name = s.get('name', 'N/A')
    sid = s['id']
    status = s['status']
    networks = s.get('networks', {}).get('v4', [])
    ip = next((n['ip_address'] for n in networks if n['type'] == 'public'), 'N/A')
    size = s.get('size', {}).get('slug', 'N/A')
    region = s.get('region', {}).get('slug', 'N/A')
    print(f'{name:<25} {sid:<10} {status:<12} {ip:<16} {size:<15} {region:<10}')
" <<< "$response"
}
