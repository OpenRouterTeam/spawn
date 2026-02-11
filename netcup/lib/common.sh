#!/bin/bash
set -eo pipefail
# Common bash functions for Netcup cloud spawn scripts

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
# Netcup Cloud specific functions
# ============================================================

readonly NETCUP_API_BASE="https://ccp.netcup.net/run/webservice/servers/endpoint.php"
# SSH_OPTS is now defined in shared/common.sh

# Netcup uses session-based authentication with API credentials
# Get session token from API credentials
netcup_get_session() {
    local customer_number="${NETCUP_CUSTOMER_NUMBER:-}"
    local api_key="${NETCUP_API_KEY:-}"
    local api_password="${NETCUP_API_PASSWORD:-}"

    if [[ -z "$customer_number" || -z "$api_key" || -z "$api_password" ]]; then
        log_error "Missing Netcup credentials"
        return 1
    fi

    local body
    body=$(python3 -c "
import json, sys
print(json.dumps({
    'action': 'login',
    'param': {
        'customernumber': sys.argv[1],
        'apikey': sys.argv[2],
        'apipassword': sys.argv[3]
    }
}))
" "$customer_number" "$api_key" "$api_password")

    local response
    response=$(curl -fsSL -X POST "$NETCUP_API_BASE" \
        -H "Content-Type: application/json" \
        -d "$body" 2>&1) || {
        log_error "Failed to connect to Netcup API"
        return 1
    }

    # Extract session ID (apisessionid)
    local session_id
    session_id=$(echo "$response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    if data.get('status') == 'success':
        print(data['responsedata']['apisessionid'])
    else:
        sys.exit(1)
except:
    sys.exit(1)
" 2>/dev/null) || {
        log_error "Failed to authenticate with Netcup API"
        log_error "Response: $response"
        return 1
    }

    echo "$session_id"
}

# Centralized API call wrapper for Netcup
netcup_api() {
    local action="$1"
    local param="${2:-{}}"

    # Get or reuse session
    if [[ -z "${NETCUP_SESSION_ID:-}" ]]; then
        NETCUP_SESSION_ID=$(netcup_get_session) || return 1
        export NETCUP_SESSION_ID
    fi

    local body
    body=$(echo "$param" | python3 -c "
import json, sys
param = json.loads(sys.stdin.read())
print(json.dumps({'action': sys.argv[1], 'param': param}))
" "$action")

    curl -fsSL -X POST "$NETCUP_API_BASE" \
        -H "Content-Type: application/json" \
        -H "X-API-Session-Id: $NETCUP_SESSION_ID" \
        -d "$body"
}

test_netcup_credentials() {
    local session_id
    session_id=$(netcup_get_session 2>&1)
    if [[ -z "$session_id" ]] || echo "$session_id" | grep -q "error\|ERROR\|failed\|Failed"; then
        log_error "Netcup API authentication failed"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Log in to your Netcup SCP at https://ccp.netcup.net/"
        log_error "  2. Navigate to Settings → API → Create API Key"
        log_error "  3. Set the following environment variables:"
        log_error "     - NETCUP_CUSTOMER_NUMBER (your customer number)"
        log_error "     - NETCUP_API_KEY (from SCP)"
        log_error "     - NETCUP_API_PASSWORD (from SCP)"
        return 1
    fi
    # Store session for reuse
    NETCUP_SESSION_ID="$session_id"
    export NETCUP_SESSION_ID
    return 0
}

# Ensure Netcup credentials are available
ensure_netcup_credentials() {
    local config_file="$HOME/.config/spawn/netcup.json"

    # Try loading from env vars first
    if [[ -n "${NETCUP_CUSTOMER_NUMBER:-}" && -n "${NETCUP_API_KEY:-}" && -n "${NETCUP_API_PASSWORD:-}" ]]; then
        if test_netcup_credentials; then
            return 0
        fi
    fi

    # Try loading from config file (single python3 call instead of 3)
    local creds
    if creds=$(_load_json_config_fields "$config_file" customer_number api_key api_password); then
        local saved_num saved_key saved_pass
        { read -r saved_num; read -r saved_key; read -r saved_pass; } <<< "${creds}"
        if [[ -n "$saved_num" ]] && [[ -n "$saved_key" ]] && [[ -n "$saved_pass" ]]; then
            log_info "Loading Netcup credentials from $config_file"
            export NETCUP_CUSTOMER_NUMBER="$saved_num" NETCUP_API_KEY="$saved_key" NETCUP_API_PASSWORD="$saved_pass"
            if test_netcup_credentials; then
                return 0
            fi
        fi
    fi

    # Prompt for credentials
    log_info "Netcup credentials not found"
    log_info "Get your API credentials at: https://ccp.netcup.net/ → Settings → API"
    log_info ""

    NETCUP_CUSTOMER_NUMBER=$(safe_read "Enter Netcup customer number: ") || return 1
    NETCUP_API_KEY=$(safe_read "Enter Netcup API key: ") || return 1
    NETCUP_API_PASSWORD=$(safe_read "Enter Netcup API password: ") || return 1
    export NETCUP_CUSTOMER_NUMBER NETCUP_API_KEY NETCUP_API_PASSWORD

    # Test credentials
    if ! test_netcup_credentials; then
        log_error "Invalid Netcup credentials"
        return 1
    fi

    _save_json_config "$config_file" \
        customer_number "$NETCUP_CUSTOMER_NUMBER" \
        api_key "$NETCUP_API_KEY" \
        api_password "$NETCUP_API_PASSWORD"

    return 0
}

# Check if SSH key is registered with Netcup
netcup_check_ssh_key() {
    local fingerprint="$1"
    # Netcup doesn't have SSH key management via API - we'll use cloud-init to inject keys
    return 1
}

# Register SSH key with Netcup (no-op - using cloud-init instead)
netcup_register_ssh_key() {
    # Netcup doesn't support SSH key registration via API
    # We inject SSH keys via cloud-init userdata instead
    return 0
}

# Ensure SSH key exists locally
ensure_ssh_key() {
    generate_ssh_key_if_missing "$HOME/.ssh/spawn_ed25519"
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "NETCUP_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# List available VPS products
_list_vps_products() {
    local response
    response=$(netcup_api "getVServerProducts" "{}")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if data.get('status') != 'success':
    sys.exit(1)
products = data.get('responsedata', {}).get('products', [])
for p in sorted(products, key=lambda x: float(x.get('price', 999))):
    name = p.get('name', 'Unknown')
    cores = p.get('cores', '?')
    ram = p.get('ram', '?')
    disk = p.get('disk', '?')
    price = p.get('price', '?')
    print(f'{name}|{cores} vCPU|{ram} MB RAM|{disk} GB disk|\${price}/mo')
"
}

# Interactive VPS product picker (delegates to shared interactive_pick)
_pick_vps_product() {
    interactive_pick "NETCUP_VPS_PRODUCT" "VPS 200 G10" "VPS products" "_list_vps_products"
}

# List available datacenters
_list_datacenters() {
    # Netcup datacenters are in Nuremberg and Vienna
    echo "Nuremberg|DE|Germany"
    echo "Vienna|AT|Austria"
}

# Interactive datacenter picker (delegates to shared interactive_pick)
_pick_datacenter() {
    interactive_pick "NETCUP_DATACENTER" "Nuremberg" "datacenters" "_list_datacenters"
}

# Build JSON request body for Netcup VPS creation
# Reads cloud-init userdata from stdin
# Usage: get_cloud_init_userdata | _netcup_build_create_body NAME PRODUCT DATACENTER IMAGE
_netcup_build_create_body() {
    python3 -c "
import json, sys
userdata = sys.stdin.read()
name, product, datacenter, image = sys.argv[1:5]
param = {
    'vservername': name,
    'product': product,
    'datacenter': datacenter,
    'image': image,
    'password': 'TempPass123!',
    'userdata': userdata
}
print(json.dumps(param))
" "$@"
}

# Poll the Netcup API until the VPS has an IPv4 address
# Sets NETCUP_SERVER_IP on success
_netcup_wait_for_ip() {
    log_info "Waiting for IP assignment..."
    local ip=""
    local attempts=0
    while [[ -z "$ip" ]] && [[ $attempts -lt 60 ]]; do
        sleep 5
        local info_response
        info_response=$(netcup_api "getVServerInfo" "{\"vserverid\": \"$NETCUP_SERVER_ID\"}")
        ip=$(echo "$info_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    if data.get('status') == 'success':
        print(data['responsedata'].get('ipv4', ''))
except:
    pass
" 2>/dev/null || echo "")
        attempts=$((attempts + 1))
    done

    if [[ -z "$ip" ]]; then
        log_error "Timeout waiting for IP assignment"
        return 1
    fi

    NETCUP_SERVER_IP="$ip"
    export NETCUP_SERVER_IP
    log_info "Server IP: $NETCUP_SERVER_IP"
}

# Create a Netcup VPS with cloud-init
create_server() {
    local name="$1"

    # Interactive selections
    local datacenter
    datacenter=$(_pick_datacenter)

    local product
    product=$(_pick_vps_product)

    local image="ubuntu-24.04"

    log_step "Creating Netcup VPS '$name' (product: $product, datacenter: $datacenter)..."

    # Get cloud-init userdata and build request body
    local param
    param=$(get_cloud_init_userdata | _netcup_build_create_body "$name" "$product" "$datacenter" "$image")

    local response
    response=$(netcup_api "createVServer" "$param")

    # Check for errors
    local status
    status=$(echo "$response" | python3 -c "import json, sys; print(json.loads(sys.stdin.read()).get('status', 'error'))")

    if [[ "$status" != "success" ]]; then
        log_error "Failed to create Netcup VPS"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('longmessage','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance"
        log_error "  - Product not available in selected datacenter"
        log_error "  - Account limits reached"
        log_error ""
        log_error "Check your account: https://ccp.netcup.net/"
        return 1
    fi

    # Extract server ID
    NETCUP_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['responsedata']['vserverid'])")
    export NETCUP_SERVER_ID
    log_info "VPS created: ID=$NETCUP_SERVER_ID"

    # Wait for IP assignment
    _netcup_wait_for_ip
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
# Netcup uses longer timeouts (max 60 attempts, 10s initial interval)
verify_server_connectivity() { ssh_verify_connectivity "${1}" "${2:-60}" 10; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a Netcup VPS
destroy_server() {
    local server_id="$1"

    log_warn "Destroying VPS $server_id..."
    local response
    response=$(netcup_api "deleteVServer" "{\"vserverid\": \"$server_id\"}")

    local status
    status=$(echo "$response" | python3 -c "import json, sys; print(json.loads(sys.stdin.read()).get('status', 'error'))")

    if [[ "$status" != "success" ]]; then
        log_error "Failed to destroy VPS: $response"
        return 1
    fi

    log_info "VPS $server_id destroyed"
}

# List all Netcup VPS
list_servers() {
    local response
    response=$(netcup_api "listVServers" "{}")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if data.get('status') != 'success':
    print('Failed to list servers')
    sys.exit(1)
servers = data.get('responsedata', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16}\")
print('-' * 65)
for s in servers:
    name = s.get('vservername', 'N/A')
    sid = str(s.get('vserverid', 'N/A'))
    status = s.get('status', 'N/A')
    ip = s.get('ipv4', 'N/A')
    print(f'{name:<25} {sid:<12} {status:<12} {ip:<16}')
" <<< "$response"
}
