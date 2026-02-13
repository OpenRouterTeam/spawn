#!/bin/bash
set -eo pipefail
# Common bash functions for RamNode Cloud spawn scripts

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
# RamNode Cloud specific functions (OpenStack API)
# ============================================================

readonly RAMNODE_API_BASE="https://openstack.ramnode.com"
readonly RAMNODE_IDENTITY_API="${RAMNODE_API_BASE}:5000/v3"
readonly RAMNODE_COMPUTE_API="${RAMNODE_API_BASE}:8774/v2.1"
readonly RAMNODE_NETWORK_API="${RAMNODE_API_BASE}:9696/v2.0"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-2}

# Get auth token from RamNode OpenStack API
_get_ramnode_token() {
    local username="$1"
    local password="$2"
    local project_id="$3"

    local auth_body
    auth_body=$(python3 -c "
import json, sys
username, password, project_id = sys.argv[1], sys.argv[2], sys.argv[3]
body = {
    'auth': {
        'identity': {
            'methods': ['password'],
            'password': {
                'user': {
                    'name': username,
                    'domain': {'id': 'default'},
                    'password': password
                }
            }
        },
        'scope': {
            'project': {
                'id': project_id,
                'domain': {'id': 'default'}
            }
        }
    }
}
print(json.dumps(body))
" "$username" "$password" "$project_id")

    local response
    response=$(curl -fsSL -X POST \
        "$RAMNODE_IDENTITY_API/auth/tokens" \
        -H "Content-Type: application/json" \
        -d "$auth_body" \
        -i 2>/dev/null || echo "")

    if [[ -z "$response" ]]; then
        return 1
    fi

    # Extract token from X-Subject-Token header
    echo "$response" | grep -i '^X-Subject-Token:' | cut -d' ' -f2 | tr -d '\r\n'
}

# Centralized curl wrapper for RamNode Compute API
ramnode_compute_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    local url="${RAMNODE_COMPUTE_API}${endpoint}"

    if [[ -z "${RAMNODE_AUTH_TOKEN:-}" ]]; then
        log_error "RAMNODE_AUTH_TOKEN not set. Authenticate first with ramnode_authenticate."
        return 1
    fi

    local curl_opts=(-fsSL -X "$method" "$url")
    curl_opts+=(-H "X-Auth-Token: ${RAMNODE_AUTH_TOKEN}")
    curl_opts+=(-H "Content-Type: application/json")

    if [[ -n "$body" ]]; then
        curl_opts+=(-d "$body")
    fi

    curl "${curl_opts[@]}" 2>/dev/null || echo '{"error": "API call failed"}'
}

# Test RamNode credentials
test_ramnode_credentials() {
    local token
    token=$(_get_ramnode_token "${RAMNODE_USERNAME}" "${RAMNODE_PASSWORD}" "${RAMNODE_PROJECT_ID}")

    if [[ -z "$token" ]]; then
        log_error "Authentication failed"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Get your OpenStack credentials from RamNode Cloud Control Panel"
        log_error "  2. Go to: https://manage.ramnode.com/ → Cloud → API Users"
        log_error "  3. Create or use existing API user and get credentials"
        log_error "  4. Set RAMNODE_USERNAME, RAMNODE_PASSWORD, and RAMNODE_PROJECT_ID"
        return 1
    fi

    # Store token for subsequent API calls
    export RAMNODE_AUTH_TOKEN="$token"
    return 0
}

# Ensure RamNode credentials are available
ensure_ramnode_credentials() {
    ensure_multi_credentials "RamNode" "$HOME/.config/spawn/ramnode.json" \
        "https://manage.ramnode.com/ -> Cloud -> API Users" test_ramnode_credentials \
        "RAMNODE_USERNAME:username:Username" \
        "RAMNODE_PASSWORD:password:Password" \
        "RAMNODE_PROJECT_ID:project_id:Project ID"
}

# Check if SSH key is registered with RamNode
ramnode_check_ssh_key() {
    local fingerprint="$1"

    # OpenStack uses different fingerprint format - we'll check by name instead
    local key_name="spawn-$(whoami)-$(hostname)"
    local response
    response=$(ramnode_compute_api GET "/os-keypairs")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
keypairs = data.get('keypairs', [])
key_name = sys.argv[1]
for kp in keypairs:
    if kp.get('keypair', {}).get('name') == key_name:
        sys.exit(0)
sys.exit(1)
" "$key_name" && return 0 || return 1
}

# Register SSH key with RamNode
ramnode_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"

    local body
    body=$(python3 -c "
import json, sys
body = {
    'keypair': {
        'name': sys.argv[1],
        'public_key': sys.stdin.read().strip()
    }
}
print(json.dumps(body))
" "$key_name" < "$pub_path")

    local response
    response=$(ramnode_compute_api POST "/os-keypairs" "$body")

    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with RamNode
ensure_ssh_key() {
    ensure_ssh_key_with_provider ramnode_check_ssh_key ramnode_register_ssh_key "RamNode"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "RAMNODE_SERVER_NAME" "Enter server name: "
}

# List available flavors (instance types)
_list_flavors() {
    local response
    response=$(ramnode_compute_api GET "/flavors/detail")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
flavors = data.get('flavors', [])
# Sort by vcpus, then ram
flavors.sort(key=lambda f: (f['vcpus'], f['ram']))
for f in flavors:
    vcpus = f['vcpus']
    ram_mb = f['ram']
    ram_gb = ram_mb / 1024
    disk_gb = f['disk']
    name = f['name']
    print(f'{name}|{vcpus} vCPU|{ram_gb:.1f} GB RAM|{disk_gb} GB disk')
"
}

# Interactive flavor picker (delegates to shared interactive_pick)
_pick_flavor() {
    interactive_pick "RAMNODE_FLAVOR" "1GB" "instance types" _list_flavors
}

# List available images
_list_images() {
    local response
    response=$(ramnode_compute_api GET "/images/detail")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
images = data.get('images', [])
# Filter for Ubuntu 24.04
ubuntu_images = [img for img in images if 'ubuntu' in img.get('name', '').lower() and '24.04' in img.get('name', '')]
if ubuntu_images:
    # Use first Ubuntu 24.04 image
    print(ubuntu_images[0]['id'])
elif images:
    # Fallback to first image
    print(images[0]['id'])
"
}

# Get default network ID
_get_network_id() {
    local response
    response=$(curl -fsSL -X GET \
        "$RAMNODE_NETWORK_API/networks" \
        -H "X-Auth-Token: ${RAMNODE_AUTH_TOKEN}" \
        -H "Content-Type: application/json" 2>/dev/null || echo '{"networks":[]}')

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
networks = data.get('networks', [])
if networks:
    print(networks[0]['id'])
"
}

# Build JSON request body for RamNode server creation
# Usage: _ramnode_build_server_body NAME FLAVOR IMAGE_ID KEY_NAME USERDATA [NETWORK_ID]
_ramnode_build_server_body() {
    python3 -c "
import json, sys
name, flavor, image_id, key_name, userdata, network_id = sys.argv[1:7]
body = {
    'server': {
        'name': name,
        'flavorRef': flavor,
        'imageRef': image_id,
        'key_name': key_name,
        'user_data': userdata
    }
}
if network_id:
    body['server']['networks'] = [{'uuid': network_id}]
print(json.dumps(body))
" "$@"
}

# Poll the RamNode API until the server is active and has an IPv4 address
# Sets RAMNODE_SERVER_IP on success
_ramnode_wait_for_ip() {
    INSTANCE_STATUS_POLL_DELAY=2 generic_wait_for_instance ramnode_compute_api "/servers/$RAMNODE_SERVER_ID" \
        "ACTIVE" "d.get('server',{}).get('status','unknown')" \
        "next((addr['addr'] for addrs in d.get('server',{}).get('addresses',{}).values() for addr in addrs if addr.get('version')==4), '')" \
        RAMNODE_SERVER_IP "Instance" 30
}

# Parse server ID from create response, or log error and return 1
# Sets RAMNODE_SERVER_ID on success
_ramnode_handle_create_response() {
    local response="$1"

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to create RamNode server"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient cloud credit (minimum \$3 required)"
        log_error "  - Flavor not available"
        log_error "  - SSH key not found"
        return 1
    fi

    RAMNODE_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
    export RAMNODE_SERVER_ID
    log_info "Server created: ID=$RAMNODE_SERVER_ID"
}

# Create a RamNode server
create_server() {
    local name="$1"

    # Get flavor
    local flavor
    flavor=$(_pick_flavor)

    # Get image ID
    log_step "Fetching Ubuntu 24.04 image..."
    local image_id
    image_id=$(_list_images)
    if [[ -z "$image_id" ]]; then
        log_error "Could not find Ubuntu 24.04 image"
        log_error ""
        log_error "How to fix:"
        log_error "  - The image may not be available in your region"
        log_error "  - Check available images at: https://manage.ramnode.com/"
        log_error "  - Contact RamNode support if the issue persists"
        return 1
    fi

    # Get network ID
    local network_id
    network_id=$(_get_network_id)

    # Get SSH key name
    local key_name="spawn-$(whoami)-$(hostname)"

    # Get cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata | base64 -w 0 || get_cloud_init_userdata | base64)

    log_step "Creating RamNode instance '$name' (flavor: $flavor)..."

    local body
    body=$(_ramnode_build_server_body "$name" "$flavor" "$image_id" "$key_name" "$userdata" "${network_id:-}")

    local response
    response=$(ramnode_compute_api POST "/servers" "$body")

    _ramnode_handle_create_response "$response" || return 1

    # Wait for IP assignment
    _ramnode_wait_for_ip
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a RamNode server
destroy_server() {
    local server_id="$1"

    log_step "Destroying server $server_id..."
    local response
    response=$(ramnode_compute_api DELETE "/servers/$server_id")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server $server_id"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_error ""
        log_error "The server may still be running and incurring charges."
        log_error "Delete it manually at: https://manage.ramnode.com/"
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all RamNode servers
list_servers() {
    local response
    response=$(ramnode_compute_api GET "/servers/detail")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<38} {'STATUS':<12} {'IP':<16}\")
print('-' * 91)
for s in servers:
    name = s['name']
    sid = str(s['id'])
    status = s['status']
    # Extract IP
    ip = 'N/A'
    addresses = s.get('addresses', {})
    for net_name, addrs in addresses.items():
        for addr in addrs:
            if addr.get('version') == 4:
                ip = addr['addr']
                break
        if ip != 'N/A':
            break
    print(f'{name:<25} {sid:<38} {status:<12} {ip:<16}')
" <<< "$response"
}
