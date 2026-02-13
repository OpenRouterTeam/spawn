#!/bin/bash
set -eo pipefail
# Common bash functions for IONOS Cloud spawn scripts

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
# IONOS Cloud specific functions
# ============================================================

readonly IONOS_API_BASE="https://api.ionos.com/cloudapi/v6"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for IONOS API
# IONOS uses Basic Auth with username (email) and password (API token)
ionos_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    # IONOS API uses Basic Auth — delegate to generic wrapper for retry logic
    generic_cloud_api_custom_auth "$IONOS_API_BASE" "$method" "$endpoint" "$body" 3 \
        -H "Authorization: Basic $(printf '%s:%s' "${IONOS_USERNAME}" "${IONOS_PASSWORD}" | base64)"
}

# Parse error message from an IONOS API error response
# Usage: error_msg=$(ionos_parse_api_error "$response")
ionos_parse_api_error() {
    local response="$1"
    _extract_json_field "$response" \
        "(lambda m: m[0].get('message','Unknown error') if m else 'Unknown error')(d.get('messages',[]))" \
        "$response"
}

# Check if an IONOS API response is an error, log it, and return 1 if so
# Usage: ionos_check_api_error "$response" "Failed to create server" && return 1
ionos_check_api_error() {
    local response="$1"
    local context="$2"

    if echo "$response" | grep -q '"httpStatus"'; then
        log_error "$context"
        local error_msg
        error_msg=$(ionos_parse_api_error "$response")
        log_error "API Error: $error_msg"
        return 0
    fi
    return 1
}

test_ionos_credentials() {
    local response
    response=$(ionos_api GET "/datacenters?depth=1&limit=1")
    if ionos_check_api_error "$response" "Authentication failed"; then
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your credentials at: https://dcd.ionos.com/ → Management → Users & Keys"
        log_error "  2. Ensure IONOS_USERNAME is your account email"
        log_error "  3. Ensure IONOS_PASSWORD is your valid API password/token"
        return 1
    fi
    return 0
}

# Ensure IONOS credentials are available (env vars -> config file -> prompt+save)
ensure_ionos_credentials() {
    ensure_multi_credentials "IONOS" "$HOME/.config/spawn/ionos.json" \
        "https://dcd.ionos.com/ -> Management -> Users & Keys" test_ionos_credentials \
        "IONOS_USERNAME:username:Username (email)" \
        "IONOS_PASSWORD:password:Password/API Key"
}

# Check if SSH key is registered with IONOS
ionos_check_ssh_key() {
    local fingerprint="$1"
    # IONOS doesn't provide SSH key listing in CloudAPI v6
    # We'll skip the check and try to register
    return 1
}

# Register SSH key with IONOS datacenter
ionos_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local datacenter_id="$3"

    local pub_key
    pub_key=$(cat "$pub_path")

    local register_body
    register_body=$(python3 -c "
import json, sys
body = {
    'properties': {
        'name': sys.argv[1],
        'publicKey': sys.argv[2]
    }
}
print(json.dumps(body))
" "$key_name" "$pub_key")

    local register_response
    register_response=$(ionos_api POST "/datacenters/${datacenter_id}/sshkeys" "$register_body")

    if ionos_check_api_error "$register_response" "Failed to register SSH key"; then
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_error "  - API credentials lack write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with IONOS
ensure_ssh_key() {
    local key_path="$HOME/.ssh/spawn_ed25519"
    local pub_path="${key_path}.pub"

    generate_ssh_key_if_missing "$key_path"

    local fingerprint
    fingerprint=$(get_ssh_fingerprint "$pub_path")
    log_info "SSH key fingerprint: $fingerprint"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "IONOS_SERVER_NAME" "Enter server name: "
}

# Try to find and use an existing IONOS datacenter
# Sets IONOS_DATACENTER_ID on success, returns 1 if none found
_ionos_find_existing_datacenter() {
    local response="$1"

    IONOS_DATACENTER_ID=$(_extract_json_field "$response" \
        "d.get('items',[])[0]['id'] if d.get('items') else ''")

    if [[ -z "$IONOS_DATACENTER_ID" ]]; then
        return 1
    fi

    local dc_name
    dc_name=$(_extract_json_field "$response" \
        "d.get('items',[])[0].get('properties',{}).get('name','N/A')")
    log_info "Using existing datacenter: $dc_name (ID: $IONOS_DATACENTER_ID)"
}

# Create a new IONOS datacenter
# Sets IONOS_DATACENTER_ID on success
_ionos_create_datacenter() {
    local location="$1"
    log_step "No datacenter found, creating new datacenter..."

    local dc_body
    dc_body=$(python3 -c "
import json, sys
body = {
    'properties': {
        'name': 'spawn-datacenter',
        'description': 'Spawn datacenter for AI agents',
        'location': sys.argv[1]
    }
}
print(json.dumps(body))
" "$location")

    local dc_response
    dc_response=$(ionos_api POST "/datacenters" "$dc_body")

    if ionos_check_api_error "$dc_response" "Failed to create datacenter"; then
        return 1
    fi

    IONOS_DATACENTER_ID=$(_extract_json_field "$dc_response" "d['id']")
    log_info "Datacenter created: $IONOS_DATACENTER_ID"
}

# Ensure datacenter exists or create one
ensure_datacenter() {
    local location="${IONOS_LOCATION:-us/las}"

    if [[ ! "$location" =~ ^[a-z]{2}/[a-z]{2,4}$ ]]; then
        log_error "Invalid IONOS_LOCATION format: '$location' (expected format: us/las)"
        return 1
    fi

    log_step "Checking for existing IONOS datacenter..."
    local response
    response=$(ionos_api GET "/datacenters?depth=1")

    if ! _ionos_find_existing_datacenter "$response"; then
        _ionos_create_datacenter "$location" || return 1
    fi

    export IONOS_DATACENTER_ID
}

# Find Ubuntu 24.04 HDD image ID from IONOS API
# Outputs the image ID on stdout
_ionos_find_ubuntu_image() {
    log_step "Finding Ubuntu 24.04 image..."
    local images_response
    images_response=$(ionos_api GET "/images?depth=2")

    _extract_json_field "$images_response" \
        "next((i['id'] for i in d.get('items',[]) if 'ubuntu' in i.get('properties',{}).get('name','').lower() and '24' in i.get('properties',{}).get('name','') and i.get('properties',{}).get('imageType','')=='HDD'), '')"
}

# Build JSON request body for IONOS volume creation
# Reads cloud-init userdata, outputs JSON body
_ionos_build_volume_body() {
    local name="$1" disk_size="$2" image_id="$3"

    local userdata
    userdata=$(get_cloud_init_userdata)

    python3 -c "
import json, sys
name, disk_size, image_id, userdata = sys.argv[1:5]
body = {
    'properties': {
        'name': name + '-boot',
        'type': 'HDD',
        'size': int(disk_size),
        'availabilityZone': 'AUTO',
        'image': image_id,
        'imagePassword': 'TempPass123!',
        'userData': userdata
    }
}
print(json.dumps(body))
" "$name" "$disk_size" "$image_id" "$userdata"
}

# Wait for an IONOS volume to reach AVAILABLE state
# Usage: _ionos_wait_for_volume VOLUME_ID [MAX_ATTEMPTS]
_ionos_wait_for_volume() {
    local volume_id="$1"
    local max_attempts="${2:-24}"
    generic_wait_for_instance ionos_api \
        "/datacenters/${IONOS_DATACENTER_ID}/volumes/${volume_id}" \
        "AVAILABLE" "d.get('metadata',{}).get('state','')" \
        "str(d.get('id',''))" \
        _IONOS_VOLUME_READY "IONOS volume" "${max_attempts}"
}

# Create a boot volume in the datacenter and wait for it to become AVAILABLE
# Usage: volume_id=$(_ionos_create_boot_volume NAME DISK_SIZE IMAGE_ID)
_ionos_create_boot_volume() {
    local name="$1"
    local disk_size="$2"
    local image_id="$3"

    log_step "Creating boot volume..."
    local volume_body
    volume_body=$(_ionos_build_volume_body "$name" "$disk_size" "$image_id")

    local volume_response
    volume_response=$(ionos_api POST "/datacenters/${IONOS_DATACENTER_ID}/volumes" "$volume_body")

    if ionos_check_api_error "$volume_response" "Failed to create volume"; then
        return 1
    fi

    local volume_id
    volume_id=$(_extract_json_field "$volume_response" "d['id']")
    log_info "Volume created: $volume_id"

    _ionos_wait_for_volume "$volume_id" || true

    echo "$volume_id"
}

# Python expression to extract IPv4 from IONOS server response (depth=3).
# Walks entities->nics->items[] to find the first assigned IP.
readonly _IONOS_IP_PY="next((ip for n in d.get('entities',{}).get('nics',{}).get('items',[]) for ip in n.get('properties',{}).get('ips',[])), '')"

# Wait for IONOS server to become AVAILABLE and get its IP
# Sets IONOS_SERVER_IP on success
_ionos_wait_for_server_ip() {
    generic_wait_for_instance ionos_api \
        "/datacenters/${IONOS_DATACENTER_ID}/servers/${IONOS_SERVER_ID}?depth=3" \
        "AVAILABLE" "d.get('metadata',{}).get('state','')" \
        "${_IONOS_IP_PY}" \
        IONOS_SERVER_IP "IONOS server" 36
}

# Build JSON request body for IONOS server creation
# Usage: _ionos_build_server_body NAME CORES RAM
_ionos_build_server_body() {
    local name="$1" cores="$2" ram="$3"
    python3 -c "
import json, sys
name, cores, ram = sys.argv[1:4]
body = {
    'properties': {
        'name': name,
        'cores': int(cores),
        'ram': int(ram),
        'availabilityZone': 'AUTO',
        'cpuFamily': 'AMD_OPTERON'
    }
}
print(json.dumps(body))
" "$name" "$cores" "$ram"
}

# Create an IONOS server instance via API and attach a boot volume
# Sets IONOS_SERVER_ID on success
# Usage: _ionos_launch_and_attach VOLUME_ID NAME CORES RAM
_ionos_launch_and_attach() {
    local volume_id="$1" name="$2" cores="$3" ram="$4"

    log_step "Creating server instance..."
    local server_body
    server_body=$(_ionos_build_server_body "$name" "$cores" "$ram")

    local server_response
    server_response=$(ionos_api POST "/datacenters/${IONOS_DATACENTER_ID}/servers" "$server_body")

    if ionos_check_api_error "$server_response" "Failed to create server"; then
        return 1
    fi

    IONOS_SERVER_ID=$(_extract_json_field "$server_response" "d['id']")
    log_info "Server created: $IONOS_SERVER_ID"
    export IONOS_SERVER_ID

    # Attach volume to server
    log_step "Attaching volume to server..."
    local attach_response
    attach_response=$(ionos_api POST "/datacenters/${IONOS_DATACENTER_ID}/servers/${IONOS_SERVER_ID}/volumes" "{\"id\": \"${volume_id}\"}")

    if ionos_check_api_error "$attach_response" "Failed to attach volume"; then
        return 1
    fi
    log_info "Volume attached successfully"
}

# Create a IONOS server with cloud-init
create_server() {
    local name="$1"
    local cores="${IONOS_CORES:-2}"
    local ram="${IONOS_RAM:-2048}"
    local disk_size="${IONOS_DISK_SIZE:-20}"

    # Validate env var inputs
    validate_resource_name "$name" || { log_error "Invalid server name"; return 1; }

    # Validate numeric env vars to prevent injection in Python strings
    if [[ ! "$cores" =~ ^[0-9]+$ ]] || [[ ! "$ram" =~ ^[0-9]+$ ]] || [[ ! "$disk_size" =~ ^[0-9]+$ ]]; then
        log_error "IONOS_CORES, IONOS_RAM, and IONOS_DISK_SIZE must be positive integers"
        return 1
    fi

    log_step "Creating IONOS server '$name' (cores: $cores, ram: ${ram}MB, disk: ${disk_size}GB)..."

    # Ensure we have a datacenter
    ensure_datacenter || return 1

    # Find Ubuntu image
    local image_id
    image_id=$(_ionos_find_ubuntu_image)
    if [[ -z "$image_id" ]]; then
        log_error "Could not find Ubuntu 24.04 image"
        return 1
    fi
    log_info "Using image ID: $image_id"

    # Create boot volume and wait for it
    local volume_id
    volume_id=$(_ionos_create_boot_volume "$name" "$disk_size" "$image_id") || return 1

    # Register SSH key with datacenter
    log_step "Registering SSH key..."
    local key_path="$HOME/.ssh/spawn_ed25519"
    local pub_path="${key_path}.pub"
    ionos_register_ssh_key "spawn-key-$(date +%s)" "$pub_path" "${IONOS_DATACENTER_ID}" || log_warn "SSH key registration failed, continuing anyway..."

    # Create server and attach volume
    _ionos_launch_and_attach "$volume_id" "$name" "$cores" "$ram" || return 1

    # Wait for server IP
    _ionos_wait_for_server_ip || return 1

    log_info "Server created successfully: ID=$IONOS_SERVER_ID, IP=$IONOS_SERVER_IP"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a IONOS server
destroy_server() {
    local datacenter_id="$1"
    local server_id="$2"

    log_step "Destroying server $server_id in datacenter $datacenter_id..."
    local response
    response=$(ionos_api DELETE "/datacenters/${datacenter_id}/servers/${server_id}")

    if ionos_check_api_error "$response" "Failed to destroy server"; then
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all IONOS servers
list_servers() {
    local response
    response=$(ionos_api GET "/datacenters?depth=3")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
found_servers = False
for dc in data.get('items', []):
    dc_name = dc.get('properties', {}).get('name', 'N/A')
    dc_id = dc.get('id', 'N/A')
    servers = dc.get('entities', {}).get('servers', {}).get('items', [])

    if servers:
        if not found_servers:
            print(f\"{'DATACENTER':<25} {'NAME':<20} {'ID':<12} {'CORES':<6} {'RAM':<8}\")
            print('-' * 75)
            found_servers = True

        for s in servers:
            props = s.get('properties', {})
            name = props.get('name', 'N/A')
            sid = s.get('id', 'N/A')
            cores = props.get('cores', 'N/A')
            ram = props.get('ram', 'N/A')
            print(f'{dc_name:<25} {name:<20} {sid:<12} {cores:<6} {ram:<8}')

if not found_servers:
    print('No servers found')
" <<< "$response"
}
